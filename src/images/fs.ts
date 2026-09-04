/**
 * An `ImageStore` backed by plain files on disk, or by an in-memory `Map`
 * when no directory is given.
 *
 * On disk, each image's content type is written to a `.type` sidecar file
 * next to its bytes.
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
      // Removes both the bytes and the content-type sidecar for each key.
      // A missing file is not an error.
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
