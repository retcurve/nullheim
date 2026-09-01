/**
 * Lets `worker.ts` `import` a prompt template as its raw text.
 *
 * Wrangler's bundler (esbuild, via the `Text` module rule in wrangler.toml)
 * resolves a `.md` import to its file contents as a string at build time —
 * there is no filesystem to `readFileSync` from at request time on
 * Cloudflare, which is exactly what `prompts.node.ts` does for the Node
 * build instead.
 */
declare module "*.md" {
  const content: string;
  export default content;
}

/**
 * Wrangler's bundler recognises `.wasm` as a built-in module type (no
 * `[[rules]]` entry needed, unlike `.md` above) and resolves it to a
 * compiled `WebAssembly.Module` at build time — see `image-processing.ts`'s
 * module comment for why the codecs need one handed to them directly rather
 * than loading their own.
 */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
