/**
 * Random ids and token hashing, on the Web Crypto API rather than node:crypto.
 *
 * `crypto.getRandomValues` and `crypto.subtle.digest` are native globals in
 * both Node 22 and the Workers runtime — unlike `node:crypto`, which Workers
 * only offers behind the `nodejs_compat` flag — so this is what lets
 * `registry.ts` and `engine.ts` run unmodified on either.
 */

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `n` random bytes as a hex string — `secrets.token_hex(n)`. */
export function randomHex(n: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

/** `n` random bytes as unpadded base64url — `secrets.token_urlsafe(n)`. */
export function randomUrlsafe(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** SHA-256 of `text`, as lowercase hex. Used to store tokens, never the token itself. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}
