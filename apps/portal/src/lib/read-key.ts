import { createHash, randomBytes } from "node:crypto";

// SCF read key format (#48, ADR 0006). Same structure as the ingest key, but
// with a different marker, so one is never valid in place of the other: the
// collector only accepts `ntf_` and the read API only accepts `nrk_`.
//
//   nrk_<prefix>_<secret>
//   prefix: 8 lowercase base32 characters (40 bits), public
//   secret: 32 bytes from the cryptographic generator, in base64url (43 characters)
//
// The database stores only the prefix and the SHA-256 of the full key. The
// full key exists only in the creation response: it never goes to a log, the
// database or an error.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export const READ_KEY_PATTERN = /^nrk_([a-z2-7]{8})_([A-Za-z0-9_-]{43})$/;

// 5 bytes = 40 bits = exactly 8 base32 digits.
function randomPrefix(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = 7; i >= 0; i--) out += BASE32[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

export function hashReadKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function generateReadKey(): { key: string; prefix: string; keyHash: Buffer } {
  const prefix = randomPrefix();
  const key = `nrk_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, keyHash: hashReadKey(key) };
}

// Key from the `Authorization: Bearer <key>` header. The scheme is case
// insensitive (RFC 7235). Null if there is no Bearer or the key does not have
// the `nrk_...` format (this includes the `ntf_` ingest key): in those cases
// the database is not even queried.
export function readKeyFromHeader(authorization: string | null): string | null {
  const match = /^Bearer (\S+)$/i.exec(authorization ?? "");
  return match && READ_KEY_PATTERN.test(match[1]!) ? match[1]! : null;
}
