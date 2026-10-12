// Farm-side secrets (BACKEND_DESIGN.md §3, §7.1): session tokens, stored only
// as SHA-256 hashes, and Apple refresh tokens, stored only encrypted.

// 32 bytes from a CSPRNG, base64url without padding: 43 characters.
export function newSessionToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

// Lowercase hex SHA-256 of a string's UTF-8 bytes.
export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const NONCE_BYTES = 12;

export function importRefreshTokenKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// AES-256-GCM with the user ID as additional authenticated data, so a
// ciphertext only decrypts on its own user's row. Layout:
// 12-byte nonce || ciphertext || 16-byte tag.
export async function encryptRefreshToken(key: CryptoKey, userId: string, token: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(userId) },
    key,
    new TextEncoder().encode(token),
  );
  const out = new Uint8Array(NONCE_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), NONCE_BYTES);
  return out;
}

export async function decryptRefreshToken(key: CryptoKey, userId: string, blob: Uint8Array<ArrayBuffer>): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.subarray(0, NONCE_BYTES), additionalData: new TextEncoder().encode(userId) },
    key,
    blob.subarray(NONCE_BYTES),
  );
  return new TextDecoder().decode(plain);
}
