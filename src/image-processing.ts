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
import { imageSize } from "image-size";
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

/** The three formats a decoder exists for, keyed by what `imageSize` calls them. */
const ACCEPTED: Record<string, "image/png" | "image/jpeg" | "image/webp"> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

interface Header {
  readonly format: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

/**
 * Reads the format and declared size from the file's header, without
 * decoding it. Returns null for anything `imageSize` cannot read, and for
 * the formats it reads that this pipeline has no decoder for.
 */
function readHeader(bytes: Uint8Array): Header | null {
  let measured;
  try {
    measured = imageSize(bytes);
  } catch {
    return null;
  }
  const format = measured.type === undefined ? undefined : ACCEPTED[measured.type];
  if (format === undefined) {
    return null;
  }
  return { format, width: measured.width, height: measured.height };
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

  const header = readHeader(bytes);
  if (header === null) {
    throw new UnsupportedImage("not a recognised PNG, JPEG or WebP file");
  }
  const { format } = header;
  if (header.width * header.height > MAX_DECODED_PIXELS) {
    throw new UnsupportedImage(
      `${header.width}x${header.height} decodes to more than ${MAX_DECODED_PIXELS} pixels`,
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
