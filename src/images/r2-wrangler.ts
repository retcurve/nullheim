/**
 * An `ImageStore` that runs `wrangler r2 object delete`. Only `delete` is
 * implemented; `put` and `get` throw.
 */

import type { ImageStore } from "../images.ts";
import { runWrangler, type WranglerRun } from "../wrangler-cli.ts";

export interface R2WranglerTarget {
  readonly bucket: string;
}

export function openR2Wrangler(target: R2WranglerTarget, run: WranglerRun = runWrangler): ImageStore {
  return {
    async put() {
      throw new Error("openR2Wrangler is read-only apart from delete — nothing should upload from a CLI");
    },
    async get() {
      throw new Error("openR2Wrangler does not read objects back — use nullheim moderate --list's dashboard link");
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) {
        const { code, stdout, stderr } = await run(["r2", "object", "delete", `${target.bucket}/${key}`, "--remote"]);
        if (code !== 0) {
          throw new Error(`wrangler r2 object delete of ${key} failed: ${stderr || stdout}`);
        }
      }
    },
  };
}
