import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Authenticated encryption for the few values that must be stored but must not
 * be readable from the database alone.
 *
 * There is exactly one of those today: the FAN, for the two minutes between
 * asking for an OTP and receiving it. The verify call needs the number sent
 * back with the code, so it has to survive between two Telegram messages, and
 * everything else in this service treats ID numbers as things to hash and
 * forget.
 *
 * What this protects against: a database dump, a leaked backup, a read replica
 * someone forgot about, SQL injection — anything that yields rows without also
 * yielding the process environment. What it does not protect against: someone
 * who has the server's environment, since that is where the key comes from.
 * That is the honest boundary, and it is still worth having: rows leak far more
 * often than environments do.
 *
 * AES-256-GCM, so a tampered ciphertext fails to decrypt rather than decrypting
 * into something else.
 */

const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. The prefix is a version, so a future change is detectable rather than a corrupt read. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(
    ".",
  );
}

/** Null for anything that does not decrypt cleanly — wrong key, tampered, or a version this build does not know. */
export function open(sealed: string, key: Buffer): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const body = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or altered ciphertext. Both mean the same thing to a caller:
    // there is nothing trustworthy here.
    return null;
  }
}
