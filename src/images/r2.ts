/**
 * Cloudflare storage: a thin pass-through to an R2 bucket binding.
 *
 * R2's own shape is what `ImageStore` is modelled on (see `../images.ts`),
 * so there is almost nothing to adapt here beyond reading the body once and
 * falling back to `application/octet-stream` for an object this store
 * didn't write itself (there shouldn't be one, but `httpMetadata` is
 * optional on R2's own type).
 */

// R2Bucket is an ambient global from @cloudflare/workers-types (see
// tsconfig.worker.json), used unimported the same way D1Database is in
// `../db/d1.ts`.

import type { ImageStore, StoredImage } from "../images.ts";

export function openR2(bucket: R2Bucket): ImageStore {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async delete(keys) {
      // R2's own signature is `string | string[]`, so a bulk delete needs no
      // adapting here at all — this is the reason the interface takes both.
      await bucket.delete(keys);
    },
    async get(key): Promise<StoredImage | null> {
      const object = await bucket.get(key);
      if (object === null) {
        return null;
      }
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },
  };
}
