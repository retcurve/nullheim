/**
 * Blob storage for processed image uploads — the same split as `db.ts`.
 *
 * `R2Bucket`'s own shape (`put(key, value, options)`, `get(key)` returning
 * an object whose body is read separately) is the one imposed by the
 * platform, so this interface is modelled on it directly; `src/images/r2.ts`
 * is close to a pass-through and `src/images/fs.ts` is the adapter doing
 * real work for local dev, writing to a plain directory on disk.
 *
 * There is no metadata table alongside this the way `sectors`/`objects`
 * have one: an image is immutable, content-addressed data with nothing to
 * query by, and R2 (and its fs stand-in) already carries the content type
 * as metadata on the object itself.
 */

export interface StoredImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface ImageStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
  /**
   * Remove one object, or many in a single call — R2 takes a whole array,
   * which is what keeps a reaper sweep two round trips rather than two per
   * image (see `Engine.reapImages`).
   *
   * Idempotent: deleting a key that is not there is not an error, which is
   * what lets a sweep re-run over a key whose blob went but whose claim row
   * did not get cleared.
   */
  delete(keys: string | string[]): Promise<void>;
}
