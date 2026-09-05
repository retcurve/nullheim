/** A `.md` import resolves to the file's contents as a string. */
declare module "*.md" {
  const content: string;
  export default content;
}

/** A `.wasm` import resolves to a compiled `WebAssembly.Module`. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
