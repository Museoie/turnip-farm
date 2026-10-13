import { describe, expect, test } from "bun:test";
import { decryptRefreshToken, encryptRefreshToken, importRefreshTokenKey, newSessionToken, sha256Hex } from "./tokens";

describe("newSessionToken", () => {
  test("is 32 random bytes as 43 base64url characters", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(newSessionToken()).not.toBe(token);
  });
});

describe("sha256Hex", () => {
  test("is lowercase hex SHA-256 of the UTF-8 bytes", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("refresh-token encryption", () => {
  const key = importRefreshTokenKey(crypto.getRandomValues(new Uint8Array(32)));

  test("round-trips, laid out as 12-byte nonce || ciphertext || 16-byte tag", async () => {
    const sealed = await encryptRefreshToken(await key, "user-1", "r.refresh-token");
    expect(sealed).toHaveLength(12 + "r.refresh-token".length + 16);
    expect(await decryptRefreshToken(await key, "user-1", sealed)).toBe("r.refresh-token");
  });

  test("uses a fresh nonce for every encryption", async () => {
    const a = await encryptRefreshToken(await key, "user-1", "same");
    const b = await encryptRefreshToken(await key, "user-1", "same");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("only decrypts for the user it was sealed for", async () => {
    const sealed = await encryptRefreshToken(await key, "user-1", "r.refresh-token");
    await expect(decryptRefreshToken(await key, "user-2", sealed)).rejects.toThrow();
  });

  test("rejects a tampered ciphertext", async () => {
    const sealed = await encryptRefreshToken(await key, "user-1", "r.refresh-token");
    sealed[14] = (sealed[14] ?? 0) ^ 1;
    await expect(decryptRefreshToken(await key, "user-1", sealed)).rejects.toThrow();
  });
});
