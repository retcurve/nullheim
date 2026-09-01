/**
 * `WebAssembly` is a real JS global everywhere this runs (Node, Cloudflare
 * Workers, every browser) but TypeScript only ships its ambient type in
 * `lib.dom.d.ts`, which this project deliberately does not pull in for the
 * Node build (see `tsconfig.json`'s `lib`) — that would hand every other
 * file browser globals that don't exist under Node. `@cloudflare/workers-
 * types` already supplies the same thing for `tsconfig.worker.json`, so
 * this is Node-build-only, just enough of the surface `wasm.node.ts` and
 * `image-processing.ts` actually use.
 */
declare namespace WebAssembly {
  class Module {
    constructor(bytes: BufferSource);
  }
}
