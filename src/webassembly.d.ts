/**
 * Ambient type declarations for the `WebAssembly` global, covering only the
 * members `wasm.node.ts` and `image-processing.ts` use.
 */
declare namespace WebAssembly {
  class Module {
    constructor(bytes: BufferSource);
  }
}
