/**
 * Compiles the WASM codecs `image-processing.ts` needs, from the .wasm files
 * shipped inside the @jsquash/* packages on disk.
 *
 * Node-only, the same split as `prompts.node.ts`/`worker.ts`'s `.md` import:
 * the Workers build gets the same five files a different way — a static
 * `import ... from "*.wasm"` (see `worker.ts`), which Cloudflare's bundler
 * resolves to a `WebAssembly.Module` at build time, because there is no
 * filesystem to read at request time.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CodecModules } from "./image-processing.ts";

function compile(specifier: string): WebAssembly.Module {
  const resolved = import.meta.resolve(specifier);
  const bytes = readFileSync(fileURLToPath(resolved));
  return new WebAssembly.Module(bytes);
}

export function loadCodecs(): CodecModules {
  return {
    png: compile("@jsquash/png/codec/pkg/squoosh_png_bg.wasm"),
    jpeg: compile("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm"),
    jpegEncode: compile("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"),
    resize: compile("@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm"),
    webpDecode: compile("@jsquash/webp/codec/dec/webp_dec.wasm"),
    webpEncode: compile("@jsquash/webp/codec/enc/webp_enc.wasm"),
  };
}
