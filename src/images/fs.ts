/**
 * Local-dev storage: plain files on disk, or an in-memory `Map` when the
 * world itself is in-memory (`--db :memory:`, `cli.ts`'s default) — nothing
 * durable to write images alongside in that case either.
 *
 * The content type has nowhere to live in a bare file the way R2 carries it
 * as object metadata, so it's written to a `.type` sidecar next to the
 * image bytes.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ImageStore, StoredImage } from "../images.ts";

export function openFsImages(dir: string | null): ImageStore {
  if (dir === null) {
    const memory = new Map<string, StoredImage>();
    return {
      async put(key, bytes, contentType) {
        memory.set(key, { bytes, contentType });
      },
      async get(key) {
        return memory.get(key) ?? null;
      },
      async delete(keys) {
        for (const key of typeof keys === "string" ? [keys] : keys) {
          memory.delete(key);
        }
      },
    };
  }

  return {
    async put(key, bytes, contentType) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, key), bytes);
      await writeFile(join(dir, `${key}.type`), contentType, "utf-8");
    },
    async delete(keys) {
      // Both the bytes and the content-type sidecar, for every key, and none
      // missing is an error — see the interface note on idempotence. R2 does
      // this in one request; a local directory has no equivalent, so the fan
      // out lives here rather than in the caller.
      await Promise.all(
        (typeof keys === "string" ? [keys] : keys).flatMap((key) => [
          rm(join(dir, key), { force: true }),
          rm(join(dir, `${key}.type`), { force: true }),
        ]),
      );
    },
    async get(key) {
      try {
        const [bytes, contentType] = await Promise.all([
          readFile(join(dir, key)),
          readFile(join(dir, `${key}.type`), "utf-8"),
        ]);
        return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), contentType };
      } catch {
        return null;
      }
    },
  };
}
