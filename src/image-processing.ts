/**
 * Resize-and-compress pipeline for agent-uploaded images.
 *
 * The @jsquash/* codecs are WASM modules built for a browser: their default
 * init() paths `fetch()` a relative .wasm URL, which Node refuses for
 * `file://` and which Workers has no request-time filesystem or network
 * fetch of its own files to answer either — see `wasm.node.ts` and
 * `worker.ts` for how each runtime instead hands this module a compiled
 * `WebAssembly.Module` directly, the same way `prompts.node.ts` and
 * `worker.ts`'s `.md` import do for the prompt templates. The WebP encoder
 * additionally feature-detects SIMD support at runtime to pick between two
 * different wasm binaries — irrelevant for occasional agent uploads and one
 * more thing that could behave differently on the two runtimes, so it is
 * bypassed entirely: this module calls the plain (non-SIMD) encoder's own
 * emscripten module factory directly rather than the package's `encode()`.
 *
 * Only JPEG and PNG are accepted as input — the two formats a screenshot or
 * a generated image actually arrives in. Output is always WebP: smaller
 * than either source at an equivalent quality, and one predictable content
 * type to store and serve back.
 */

import { decode as decodePng } from "@jsquash/png";
import { init as initPngDecode } from "@jsquash/png/decode.js";
import decodeJpeg from "@jsquash/jpeg/decode.js";
import { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import resizeImage, { initResize } from "@jsquash/resize";
import webpEncoderFactory from "@jsquash/webp/codec/enc/webp_enc.js";
import { defaultOptions as webpDefaultOptions } from "@jsquash/webp/meta.js";
import { initEmscriptenModule } from "@jsquash/webp/utils.js";

/** Refused before decoding even starts — this is the raw upload, not the output. */
export const MAX_UPLOAD_BYTES = 5_000_000;

export const MAX_OUTPUT_WIDTH = 800;

const WEBP_QUALITY = 80;

/** The four WASM modules this pipeline needs, compiled by whichever runtime is hosting it. */
export interface CodecModules {
  readonly png: WebAssembly.Module;
  readonly jpeg: WebAssembly.Module;
  readonly resize: WebAssembly.Module;
  readonly webpEncode: WebAssembly.Module;
}

export interface ProcessedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

/** The upload is too large, or isn't really a JPEG or PNG regardless of its declared type. */
export class UnsupportedImage extends Error {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The real format, sniffed from the file's own magic bytes — never trust a
 * declared `Content-Type`, which is just whatever the caller claims.
 */
function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

type WebpModule = Awaited<ReturnType<typeof initEmscriptenModule>>;
let webpModule: Promise<WebpModule> | null = null;
let ready: Promise<void> | null = null;

/** Initialise every codec exactly once, from the modules the caller supplied. */
function ensureReady(codecs: CodecModules): Promise<void> {
  if (ready === null) {
    ready = (async () => {
      await initPngDecode(codecs.png);
      await initJpegDecode(codecs.jpeg);
      await initResize(codecs.resize);
      webpModule = initEmscriptenModule(webpEncoderFactory, codecs.webpEncode);
      await webpModule;
    })();
  }
  return ready;
}

/**
 * Sniff, decode, resize (only if wider than `MAX_OUTPUT_WIDTH`) and
 * re-encode as WebP.
 */
export async function processUpload(
  bytes: Uint8Array,
  codecs: CodecModules,
): Promise<ProcessedImage> {
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new UnsupportedImage(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
  await ensureReady(codecs);

  const format = sniff(bytes);
  if (format === null) {
    throw new UnsupportedImage("not a recognised PNG or JPEG file");
  }

  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const decoded =
    format === "image/png" ? await decodePng(buffer) : await decodeJpeg(buffer);

  const scale = Math.min(1, MAX_OUTPUT_WIDTH / decoded.width);
  const targetWidth = Math.max(1, Math.round(decoded.width * scale));
  const targetHeight = Math.max(1, Math.round(decoded.height * scale));
  const resized =
    scale < 1 ? await resizeImage(decoded, { width: targetWidth, height: targetHeight }) : decoded;

  const module = await webpModule!;
  // The raw emscripten binding (bypassed here — see the module comment)
  // expects the encoder's full options struct, not a partial override the
  // way the package's own `encode()` wrapper accepts.
  const encoded = module.encode(resized.data, resized.width, resized.height, {
    ...webpDefaultOptions,
    quality: WEBP_QUALITY,
  });
  if (!encoded) {
    throw new Error("webp encoding failed");
  }

  return {
    bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
    contentType: "image/webp",
    width: resized.width,
    height: resized.height,
  };
}
