/**
 * The @jsquash/* packages ship typed entry points (decode.d.ts, encode.d.ts,
 * ...) but not for the raw emscripten glue one level below them, or for the
 * WebP-specific `utils.js` helper — `image-processing.ts` imports both
 * directly to bypass the packages' own browser-oriented wasm loading (see
 * its module comment). These are minimal shims for exactly the shapes used
 * there, not a full re-typing of the packages.
 */
declare module "@jsquash/webp/utils.js" {
  export function initEmscriptenModule(
    moduleFactory: (options: Record<string, unknown>) => Promise<unknown>,
    wasmModule?: WebAssembly.Module,
    moduleOptionOverrides?: Record<string, unknown>,
  ): Promise<{
    encode(
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options: Record<string, unknown>,
    ): Uint8Array | null;
  }>;
}

declare module "@jsquash/webp/codec/enc/webp_enc.js" {
  const factory: (options: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
