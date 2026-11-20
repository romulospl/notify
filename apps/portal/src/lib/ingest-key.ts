import { createHash, randomBytes } from "node:crypto";

// Ingest key format (E2 spec, section 5). It is the contract with the
// collector (#30), which validates the key with the same hash.
//
//   ntf_<prefix>_<secret>
//   prefix: 8 lowercase base32 characters (40 bits), public
//   secret: 32 bytes from the cryptographic generator, in base64url (43 characters)
//
// The database stores only the prefix and the SHA-256 of the full key. The
// full key exists only in the creation response: it never goes to a log, the
// database or an error.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export const KEY_PATTERN = /^ntf_([a-z2-7]{8})_([A-Za-z0-9_-]{43})$/;

// 5 bytes = 40 bits = exactly 8 base32 digits.
function randomPrefix(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = 7; i >= 0; i--) out += BASE32[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

export function hashIngestKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function generateIngestKey(): { key: string; prefix: string; keyHash: Buffer } {
  const prefix = randomPrefix();
  const key = `ntf_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, keyHash: hashIngestKey(key) };
}
