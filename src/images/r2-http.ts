/**
 * R2 over Cloudflare's REST API — the blob half of what `nullheim moderate`
 * needs to reach a deployed world. See `../db/d1-http.ts` for why either of
 * these exists; the same warning applies, and for the same reason: the
 * Worker has a real R2 binding (`./r2.ts`) and should never come here.
 *
 * Only `delete` is implemented. It is the one operation a human reviewer
 * performs on bytes — `--reject` is this world's takedown path, and it
 * clears the blob before it clears the row that names it (`Engine.reject-
 * Image`, whose comment has the ordering argument). `put` and `get` throw:
 * an operator CLI has no business uploading an image, and nothing in the
 * review flow reads one back, since deciding what an image *depicts* happens
 * by eye in a browser against the running world, not through this file.
 * Implementing them speculatively would mean shipping two untested paths
 * into a store that can delete production data.
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
        // Deleting an absent key is not an error — the interface says so, and
        // a reaper or a re-run of `--reject` depends on it.
        if (!response.ok && response.status !== 404) {
          throw new Error(`R2 delete of ${key} failed (HTTP ${response.status})`);
        }
      }
    },
  };
}
