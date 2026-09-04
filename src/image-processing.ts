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
 * JPEG, PNG and WebP are accepted as input — the formats a screenshot or a
 * generated image actually arrives in (many image-gen systems emit WebP
 * directly). Output is always WebP: smaller than either source at an
 * equivalent quality, and one predictable content type to store and serve
 * back — an already-WebP upload is still decoded and re-encoded, both to
 * enforce the resize cap and because a re-encode at a known quality is
 * cheaper to reason about than trusting whatever quality the upload was
 * encoded at.
 *
 * A third output, `classification`, is a second, smaller JPEG built from the
 * same decode — for the moderation classifier, never for display. See
 * `MAX_CLASSIFICATION_WIDTH`.
 */

import { decode as decodePng } from "@jsquash/png";
import { init as initPngDecode } from "@jsquash/png/decode.js";
import decodeJpeg from "@jsquash/jpeg/decode.js";
import { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import encodeJpeg from "@jsquash/jpeg/encode.js";
import { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import decodeWebp from "@jsquash/webp/decode.js";
import { init as initWebpDecode } from "@jsquash/webp/decode.js";
import resizeImage, { initResize } from "@jsquash/resize";
import webpEncoderFactory from "@jsquash/webp/codec/enc/webp_enc.js";
import { defaultOptions as webpDefaultOptions } from "@jsquash/webp/meta.js";
import { initEmscriptenModule } from "@jsquash/webp/utils.js";

/** Refused before decoding even starts — this is the raw upload, not the output. */
export const MAX_UPLOAD_BYTES = 5_000_000;

/**
 * The second cap, and the one that actually bounds memory: what a decode
 * allocates is the *decoded* surface, which the byte cap above says nothing
 * about. Compression ratios run to four orders of magnitude on flat images,
 * so a well-formed PNG comfortably inside `MAX_UPLOAD_BYTES` can declare
 * 20000×20000 and ask for 1.6 GB of RGBA — on Workers, where the whole
 * isolate gets 128 MB, one such upload is the isolate.
 *
 * 12 megapixels is past any real screenshot or generated image (4K is 8.3)
 * and bounds a decode at ~48 MB, and the output is capped at 800px wide
 * regardless, so nothing above this was ever going to survive the resize
 * as anything but wasted work.
 */
export const MAX_DECODED_PIXELS = 12_000_000;

export const MAX_OUTPUT_WIDTH = 800;

const WEBP_QUALITY = 80;

/**
 * The width a second, separate copy is downscaled to for the moderation
 * classifier (`Engine.uploadImage`) — never the stored image. Measured
 * directly against Workers AI, 2026-09-04 (see CLAUDE.md's moderation
 * entry): above this, cost scaled with the original image's resolution
 * (image tokens, not the classifier's short answer); at and below it, cost
 * flattened to the same ~8 neurons regardless of input size — the
 * signature of hitting the model's own internal encoder size, past which
 * further downscaling on this end is undone on the far end anyway. Recall
 * on 3 known-unsafe test images held at this size with the validated
 * prompt. Not pushed smaller: once cost has already flattened, shrinking
 * further can only cost recall (a hate symbol, a weapon, gore occupying a
 * small part of the frame) for no measured saving.
 */
export const MAX_CLASSIFICATION_WIDTH = 384;

/** The five WASM modules this pipeline needs, compiled by whichever runtime is hosting it. */
export interface CodecModules {
  readonly png: WebAssembly.Module;
  readonly jpeg: WebAssembly.Module;
  readonly jpegEncode: WebAssembly.Module;
  readonly resize: WebAssembly.Module;
  readonly webpDecode: WebAssembly.Module;
  readonly webpEncode: WebAssembly.Module;
}

export interface ProcessedImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  /**
   * A second, much smaller copy of the same decode, for the moderation
   * classifier (`Engine.uploadImage`) rather than for display — see
   * `MAX_CLASSIFICATION_WIDTH`. Always JPEG regardless of the upload's own
   * format or the stored copy's WebP, because that is what was validated
   * against Workers AI — see `moderation/workers-ai.ts`'s module comment.
   * Built from the already-decoded, already-resized surface, so this never
   * costs a second decode of the upload itself.
   */
  readonly classification: { readonly bytes: Uint8Array; readonly contentType: "image/jpeg" };
}

/** The upload is too large, or isn't really a JPEG, PNG or WebP regardless of its declared type. */
export class UnsupportedImage extends Error {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8 of a RIFF file

/**
 * The real format, sniffed from the file's own magic bytes — never trust a
 * declared `Content-Type`, which is just whatever the caller claims.
 */
function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    RIFF_SIGNATURE.every((b, i) => bytes[i] === b) &&
    WEBP_SIGNATURE.every((b, i) => bytes[i + 8] === b)
  ) {
    return "image/webp";
  }
  return null;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The frame size a JPEG declares, from the first SOF segment.
 *
 * Every SOF marker (baseline, progressive, arithmetic, lossless) carries the
 * same header — precision, height, width — and always precedes the scan
 * data, so walking the segment chain finds it without decoding anything.
 * `0xC4`, `0xC8` and `0xCC` sit in that range and are not frame headers.
 */
function jpegSize(bytes: Uint8Array, view: DataView): Size | null {
  let offset = 2; // past SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte before the real marker
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2; // standalone: no length, no payload
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) {
      return null;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * The canvas size a WebP declares. Three container shapes, and the fourcc at
 * offset 12 says which: `VP8 ` (lossy), `VP8L` (lossless), `VP8X` (extended
 * — what an alpha channel or an animation is wrapped in).
 */
function webpSize(bytes: Uint8Array, view: DataView): Size | null {
  const fourcc = String.fromCharCode(...bytes.slice(12, 16));
  if (fourcc === "VP8X" && bytes.length >= 30) {
    return {
      width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1,
      height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1,
    };
  }
  if (
    fourcc === "VP8 " &&
    bytes.length >= 30 &&
    // The keyframe start code, immediately before the 14-bit dimensions.
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (fourcc === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = view.getUint32(21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * What this file says it will decode to, read from its own header — the
 * check `MAX_DECODED_PIXELS` needs, and the one thing about an upload that
 * has to be known *before* a decoder is handed the bytes.
 *
 * `null` means the header could not be read, which is refused rather than
 * waved through: failing open here would leave exactly the path this guard
 * exists to close, and a file whose header these three parsers cannot read
 * is not one the codecs were going to decode either.
 */
function declaredSize(bytes: Uint8Array, format: NonNullable<ReturnType<typeof sniff>>): Size | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === "image/png") {
    if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") {
      return null;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (format === "image/jpeg") {
    return jpegSize(bytes, view);
  }
  return webpSize(bytes, view);
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
      await initJpegEncode(codecs.jpegEncode);
      await initWebpDecode(codecs.webpDecode);
      await initResize(codecs.resize);
      webpModule = initEmscriptenModule(webpEncoderFactory, codecs.webpEncode);
      await webpModule;
    })();
  }
  return ready;
}

/**
 * Sniff, check the declared size, decode, resize (only if wider than
 * `MAX_OUTPUT_WIDTH`) and re-encode as WebP.
 *
 * Both refusals that can happen before the decode — the byte cap and the
 * pixel cap — happen before it deliberately: everything after this point
 * allocates in proportion to what the file *claims*, not to what it cost to
 * send.
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
    throw new UnsupportedImage("not a recognised PNG, JPEG or WebP file");
  }

  const size = declaredSize(bytes, format);
  if (size === null) {
    throw new UnsupportedImage(`the ${format} header is unreadable, so its size is unknown`);
  }
  if (size.width * size.height > MAX_DECODED_PIXELS) {
    throw new UnsupportedImage(
      `${size.width}x${size.height} decodes to more than ${MAX_DECODED_PIXELS} pixels`,
    );
  }

  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const decoded =
    format === "image/png"
      ? await decodePng(buffer)
      : format === "image/jpeg"
        ? await decodeJpeg(buffer)
        : await decodeWebp(buffer);

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

  // A second, smaller resize of the same already-decoded surface, purely for
  // the moderation classifier — see `MAX_CLASSIFICATION_WIDTH` and
  // `ProcessedImage.classification`. JPEG (unlike WebP above) needs no
  // bypass of its own package `encode()`: MozJPEG has no SIMD-variant
  // question to dodge.
  const classificationScale = Math.min(1, MAX_CLASSIFICATION_WIDTH / resized.width);
  const classificationTarget =
    classificationScale < 1
      ? await resizeImage(resized, {
          width: Math.max(1, Math.round(resized.width * classificationScale)),
          height: Math.max(1, Math.round(resized.height * classificationScale)),
        })
      : resized;
  const classificationBytes = new Uint8Array(await encodeJpeg(classificationTarget));

  return {
    bytes: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
    contentType: "image/webp",
    width: resized.width,
    height: resized.height,
    classification: { bytes: classificationBytes, contentType: "image/jpeg" },
  };
}
