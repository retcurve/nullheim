/**
 * Decodes an uploaded image, resizes it, and re-encodes it as WebP.
 *
 * Accepts JPEG, PNG and WebP input. The caller supplies each codec's
 * compiled `WebAssembly.Module` directly. The WebP encoder is called
 * through its plain (non-SIMD) emscripten module factory rather than the
 * package's own `encode()` wrapper.
 *
 * Also produces a second, smaller JPEG (`classification`) from the same
 * decode, for the moderation classifier — see `MAX_CLASSIFICATION_WIDTH`.
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

/** Maximum accepted size of the raw upload, checked before decoding. */
export const MAX_UPLOAD_BYTES = 5_000_000;

/** Maximum accepted decoded pixel count (width × height), checked from the file's declared size before decoding. */
export const MAX_DECODED_PIXELS = 12_000_000;

/** Maximum width of the stored output image; taller/wider images are downscaled to this width. */
export const MAX_OUTPUT_WIDTH = 800;

const WEBP_QUALITY = 80;

/** Width the classification copy is downscaled to, separately from the stored image. */
export const MAX_CLASSIFICATION_WIDTH = 384;

/** The five WASM modules this pipeline needs, compiled by the caller's runtime. */
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
  /** A smaller JPEG copy for the moderation classifier, built from the same decode. */
  readonly classification: { readonly bytes: Uint8Array; readonly contentType: "image/jpeg" };
}

/** Thrown when the upload is too large, or is not a JPEG, PNG or WebP file. */
export class UnsupportedImage extends Error {}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8 of a RIFF file

/** Detects the image format from its magic bytes. */
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

/** Reads the frame size from a JPEG's first SOF segment, without decoding the image. */
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

/** Reads the canvas size from a WebP file, handling its three container shapes (VP8, VP8L, VP8X). */
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
    // The keyframe start code, immediately before the width and height fields.
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

/** Reads the declared width and height from the file's header without decoding it. Returns null if the header can't be read. */
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

/** Initializes every codec once, from the modules passed in. */
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
 * Detects the format, checks the declared size, decodes, resizes to at
 * most `MAX_OUTPUT_WIDTH` wide, and re-encodes as WebP. Also produces a
 * downscaled JPEG copy for classification.
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
  // Passes the encoder's full options struct, since this binding does not
  // accept a partial override.
  const encoded = module.encode(resized.data, resized.width, resized.height, {
    ...webpDefaultOptions,
    quality: WEBP_QUALITY,
  });
  if (!encoded) {
    throw new Error("webp encoding failed");
  }

  // Resizes the already-resized surface again, to MAX_CLASSIFICATION_WIDTH, and encodes it as JPEG.
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
