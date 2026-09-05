/**
 * Blob storage for processed image uploads.
 *
 * The interface follows `R2Bucket`'s own shape (`put(key, value, options)`,
 * `get(key)` returning an object whose body is read separately).
 * `src/images/r2.ts` is close to a pass-through; `src/images/fs.ts` adapts
 * this to a plain directory on disk for local dev.
 *
 * This store holds only the bytes and content type of an image, keyed by
 * name. Moderation state (`state`, `score`, reviewer) is tracked separately,
 * in the `images` SQL table via `WorldStore`.
 */

export interface StoredImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface ImageStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
  /**
   * Removes one object, or many in a single call. Deleting a key that does
   * not exist is not an error.
   */
  delete(keys: string | string[]): Promise<void>;
}
