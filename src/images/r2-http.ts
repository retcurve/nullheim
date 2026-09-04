/**
 * An `ImageStore` backed by R2's REST API instead of a Worker binding.
 *
 * Only `delete` is implemented; `put` and `get` throw.
 */

import type { ImageStore } from "../images.ts";

export interface R2HttpTarget {
  readonly accountId: string;
  readonly bucket: string;
  readonly token: string;
}

export function openR2Http(target: R2HttpTarget): ImageStore {
  const base =
    `https://api.cloudflare.com/client/v4/accounts/${target.accountId}` +
    `/r2/buckets/${target.bucket}/objects`;

  return {
    async put() {
      throw new Error("openR2Http is read-only apart from delete — nothing should upload from a CLI");
    },
    async get() {
      throw new Error("openR2Http does not read objects back — view images in the running world");
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        const response = await fetch(`${base}/${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${target.token}` },
        });
        // A 404 is treated as success.
        if (!response.ok && response.status !== 404) {
          throw new Error(`R2 delete of ${key} failed (HTTP ${response.status})`);
        }
      }
    },
  };
}
