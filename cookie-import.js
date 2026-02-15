const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_BASE = path.join(os.homedir(),
  'Library/Application Support/Google/Chrome');

// ── Detect Chrome profiles and find the last-used one ──
function getChromeProfilePath() {
  const localStatePath = path.join(CHROME_BASE, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new Error('Chrome Local State not found. Is Chrome installed?');
  }

  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  // last_used can be null/undefined; also check last_active_profiles array
  const lastUsed = localState.profile?.last_used
    || (localState.profile?.last_active_profiles || [])[0]
    || 'Default';
  const profilePath = path.join(CHROME_BASE, lastUsed);

  if (!fs.existsSync(profilePath)) {
    throw new Error(`Chrome profile not found: ${lastUsed}`);
  }

  return { profilePath, profileName: lastUsed };
}

// ── Get the Chrome Safe Storage encryption key from macOS Keychain ──
function getChromeEncryptionKey() {
  const rawKey = execSync(
    'security find-generic-password -s "Chrome Safe Storage" -w',
    { encoding: 'utf8', timeout: 30000 }
  ).trim();

  // Derive AES-128 key: PBKDF2 with salt "saltysalt", 1003 iterations
  return crypto.pbkdf2Sync(rawKey, 'saltysalt', 1003, 16, 'sha1');
}

// ── Decrypt a single cookie value ──
// Chrome's v10 format: "v10" + AES-128-CBC(hmac[32] + value, key, iv)
// After decryption and padding removal, the first 32 bytes are an HMAC
// and the actual cookie value starts at byte 32.
const CHROME_HMAC_PREFIX_LEN = 32;

function decryptValue(hexEncrypted, key) {
  const buf = Buffer.from(hexEncrypted, 'hex');
  if (buf.length === 0) return '';

  const prefix = buf.slice(0, 3).toString('ascii');

  if (prefix === 'v10') {
    const iv = Buffer.alloc(16, 0x20); // 16 space characters
    const ciphertext = buf.slice(3);
    if (ciphertext.length === 0) return '';

    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(true);

    // Decrypt as raw bytes first (not utf8) to avoid mangling
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);

    // Strip the 32-byte HMAC prefix to get the actual cookie value
    if (decrypted.length > CHROME_HMAC_PREFIX_LEN) {
      return decrypted.slice(CHROME_HMAC_PREFIX_LEN).toString('utf8');
    }

    // Fallback for very short values (shouldn't happen in practice)
    return decrypted.toString('utf8');
  }

  // Unencrypted (rare, but possible for very old cookies)
  return buf.toString('utf8');
}

// ── Read and decrypt Chrome cookies for given domain patterns ──
function readChromeCookies(domainPatterns) {
  const { profilePath, profileName } = getChromeProfilePath();
  const cookiesDb = path.join(profilePath, 'Cookies');

  if (!fs.existsSync(cookiesDb)) {
    throw new Error(`Cookies database not found in profile "${profileName}"`);
  }

  const key = getChromeEncryptionKey();

  // Copy the database + WAL/SHM to a temp location (avoids SQLite lock issues)
  const tmp = path.join(os.tmpdir(), `llm_council_cookies_${Date.now()}`);
  fs.copyFileSync(cookiesDb, tmp);
  for (const ext of ['-wal', '-shm']) {
    const src = cookiesDb + ext;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, tmp + ext);
    }
  }

  try {
    const whereClauses = domainPatterns
      .map(d => `host_key LIKE '%${d}%'`)
      .join(' OR ');

    const sql = `SELECT host_key, name, path, hex(encrypted_value), is_secure, is_httponly, expires_utc, samesite FROM cookies WHERE ${whereClauses};`;

    let output;
    try {
      output = execSync(`sqlite3 -separator '|||' "${tmp}" "${sql}"`, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 15000
      });
    } catch (err) {
      throw new Error('Failed to query Chrome cookies database: ' + err.message);
    }

    if (!output.trim()) return { cookies: [], profileName };

    const cookies = [];
    for (const line of output.trim().split('\n')) {
      const parts = line.split('|||');
      if (parts.length < 8) continue;

      const [hostKey, name, cookiePath, encHex, isSecure, isHttpOnly, expiresUtc, sameSite] = parts;

      let value;
      try {
        value = decryptValue(encHex, key);
      } catch {
        continue; // skip undecryptable cookies
      }

      // Chrome timestamps are microseconds since Jan 1 1601
      const chromeEpoch = BigInt(expiresUtc || '0');
      const unixEpoch = chromeEpoch > 0n
        ? Number((chromeEpoch - 11644473600000000n) / 1000000n)
        : 0;

      const host = hostKey.startsWith('.') ? hostKey.slice(1) : hostKey;
      const secure = isSecure === '1';

      // Map Chrome samesite values to Electron's
      let sameSiteStr = 'unspecified';
      if (sameSite === '0') sameSiteStr = 'no_restriction';
      else if (sameSite === '1') sameSiteStr = 'lax';
      else if (sameSite === '2') sameSiteStr = 'strict';

      cookies.push({
        url: `http${secure ? 's' : ''}://${host}${cookiePath}`,
        name,
        value,
        domain: hostKey,
        path: cookiePath,
        secure,
        httpOnly: isHttpOnly === '1',
        expirationDate: unixEpoch > 0 ? unixEpoch : undefined,
        sameSite: sameSiteStr
      });
    }

    return { cookies, profileName };
  } finally {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm']) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

module.exports = { readChromeCookies, getChromeProfilePath };
