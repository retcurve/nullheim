/**
 * Type declarations for two @jsquash/* internal modules that ship no types
 * of their own, covering only the functions `image-processing.ts` imports.
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
