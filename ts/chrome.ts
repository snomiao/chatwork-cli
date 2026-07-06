// Chrome profile discovery + cookie decryption for the --from-chrome login flow.
// macOS only (v10 prefix scheme: PBKDF2(salt=saltysalt, iter=1003, sha1, 16B)
// + AES-128-CBC, IV=0x20*16). Linux uses iter=1 + service="Chromium Safe Storage";
// not implemented here.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { Database } from "bun:sqlite";

const CHROME_ROOT = join(
  homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
);

export interface ChromeProfile {
  dir: string;          // e.g. "Default", "Profile 1"
  displayName: string;  // human label, e.g. "example.co.jp"
  userEmail?: string;
  path: string;         // absolute path to the profile dir
}

export function listChromeProfiles(): ChromeProfile[] {
  const localState = join(CHROME_ROOT, "Local State");
  if (!existsSync(localState)) {
    throw new Error(`Chrome not installed or no profiles at ${CHROME_ROOT}`);
  }
  const raw = JSON.parse(readFileSync(localState, "utf8")) as {
    profile?: { info_cache?: Record<string, { name?: string; user_name?: string }> };
  };
  const cache = raw.profile?.info_cache ?? {};
  const profiles: ChromeProfile[] = [];
  for (const [dir, info] of Object.entries(cache)) {
    const path = join(CHROME_ROOT, dir);
    if (!existsSync(path)) continue;
    const entry: ChromeProfile = {
      dir,
      displayName: info.name ?? dir,
      path,
    };
    if (info.user_name) entry.userEmail = info.user_name;
    profiles.push(entry);
  }
  // Stable order: Default first, then by directory name.
  profiles.sort((a, b) => {
    if (a.dir === "Default") return -1;
    if (b.dir === "Default") return 1;
    return a.dir.localeCompare(b.dir);
  });
  return profiles;
}

let cachedKey: Buffer | undefined;
function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  // security(1) returns the random per-user secret. May prompt the Keychain
  // dialog on first use; once "Always Allow" is set further calls are silent.
  const password = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    { encoding: "utf8" },
  ).trim();
  cachedKey = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  return cachedKey;
}

export interface DecryptedCookie {
  host: string;
  name: string;
  value: string;
  path: string;
  expiresUtc: number;
  isSecure: boolean;
}

interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: number;
  is_secure: number;
}

function decryptV10(encrypted: Buffer, key: Buffer): string {
  // Strip the 3-byte "v10" prefix, then AES-128-CBC with a fixed IV of 16
  // spaces. PKCS#7 padding handled by setAutoPadding default.
  const ct = encrypted.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  // Chrome 124+ on macOS prepends SHA-256(host_key) as an integrity check to
  // the plaintext before encryption. Strip those 32 bytes when present.
  const body = pt.length >= 32 ? pt.subarray(32) : pt;
  return body.toString("utf8");
}

export function readCookiesForDomain(
  profile: ChromeProfile,
  domainSuffix: string,
): DecryptedCookie[] {
  const cookiesDb = join(profile.path, "Cookies");
  if (!existsSync(cookiesDb)) {
    throw new Error(`No Cookies db in profile ${profile.dir}`);
  }
  // Open read-only + immutable so we don't fight Chrome's WAL.
  const db = new Database(cookiesDb, { readonly: true });
  try {
    const rows = db
      .query<CookieRow, [string, string]>(
        "SELECT host_key, name, encrypted_value, path, expires_utc, is_secure FROM cookies WHERE host_key LIKE ? OR host_key LIKE ?",
      )
      .all(`%${domainSuffix}`, `%.${domainSuffix}`);
    const key = deriveKey();
    const out: DecryptedCookie[] = [];
    for (const row of rows) {
      // bun:sqlite returns BLOBs as Uint8Array — wrap to Buffer so the byte
      // ops (subarray.toString("utf8"), Buffer.concat) behave.
      const enc = Buffer.from(row.encrypted_value);
      if (enc.length < 4) continue;
      const prefix = enc.subarray(0, 3).toString("utf8");
      if (prefix !== "v10") continue; // Skip ABE/v20 entries — unsupported.
      try {
        const value = decryptV10(enc, key);
        out.push({
          host: row.host_key,
          name: row.name,
          value,
          path: row.path,
          expiresUtc: row.expires_utc,
          isSecure: row.is_secure === 1,
        });
      } catch {
        // A single bad cookie shouldn't fail the whole import.
      }
    }
    return out;
  } finally {
    db.close();
  }
}

// Extract the API token from the rendered token.php HTML. Stable selector:
// <input name="token" ... value="<hex>"> alongside a hidden CSRF input.
export function parseTokenFromHtml(html: string): string | null {
  const m = html.match(
    /<input\b[^>]*\bname="token"[^>]*\bvalue="([0-9a-f]{32,})"/i,
  );
  return m ? m[1]! : null;
}

// Build a Cookie: header value for a target URL given a flat list of cookies.
export function cookieHeader(cookies: DecryptedCookie[], targetUrl: string): string {
  const u = new URL(targetUrl);
  const host = u.hostname;
  const matched = cookies.filter((c) => {
    if (c.host.startsWith(".")) {
      const bare = c.host.slice(1);
      return host === bare || host.endsWith("." + bare);
    }
    return c.host === host;
  });
  // De-dupe by name, keeping the more specific (longer host) entry.
  const byName = new Map<string, DecryptedCookie>();
  for (const c of matched) {
    const prev = byName.get(c.name);
    if (!prev || c.host.length > prev.host.length) byName.set(c.name, c);
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join("; ");
}
