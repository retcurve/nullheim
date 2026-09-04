/**
 * An `ImageStore` backed by an R2 bucket binding.
 */

// R2Bucket is an ambient global from @cloudflare/workers-types, used
// unimported.

import type { ImageStore, StoredImage } from "../images.ts";

export function openR2(bucket: R2Bucket): ImageStore {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async delete(keys) {
      // Accepts a single key or an array of keys.
      await bucket.delete(keys);
    },
    async get(key): Promise<StoredImage | null> {
      const object = await bucket.get(key);
      if (object === null) {
        return null;
      }
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        // Falls back to a default content type if none was stored.
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
  };
}
