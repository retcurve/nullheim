/** Resize-and-compress pipeline: `processUpload`. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DECODED_PIXELS,
  MAX_OUTPUT_WIDTH,
  UnsupportedImage,
  processUpload,
} from "./image-processing.ts";
import { makePng } from "./testing.ts";
import { loadCodecs } from "./wasm.node.ts";

const CODECS = loadCodecs();

/**
 * Builds a JPEG containing only a header: SOI, a JFIF APP0 segment, and an
 * SOF0 segment carrying the given width and height. Not a decodable image.
 */
function makeJpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0, 16 bytes including this length
    0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, // JFIF payload
    0xff, 0xc0, 0x00, 0x0b, // SOF0, 11 bytes including this length
    0x08, // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, // one component
  ]);
}

describe("processUpload", () => {
  test("a source wider than the cap is resized down, aspect ratio preserved", async () => {
    const result = await processUpload(makePng(1600, 900), CODECS);
    assert.equal(result.width, MAX_OUTPUT_WIDTH);
    assert.equal(result.height, 450);
    assert.equal(result.contentType, "image/webp");
    assert.ok(result.bytes.length > 0);
  });

  test("a source already within the cap is left at its own size", async () => {
    const result = await processUpload(makePng(200, 100), CODECS);
    assert.equal(result.width, 200);
    assert.equal(result.height, 100);
  });

  test("output is always WebP, magic bytes included", async () => {
    const result = await processUpload(makePng(50, 50), CODECS);
    const header = Buffer.from(result.bytes.slice(0, 12)).toString("ascii");
    assert.ok(header.startsWith("RIFF"));
    assert.ok(header.includes("WEBP"));
  });

  test("a WebP upload is accepted and re-encoded", async () => {
    const webp = (await processUpload(makePng(200, 100), CODECS)).bytes;
    const result = await processUpload(webp, CODECS);
    assert.equal(result.width, 200);
    assert.equal(result.height, 100);
    assert.equal(result.contentType, "image/webp");
  });

  test("not a real PNG, JPEG or WebP is refused regardless of what it claims to be", async () => {
    await assert.rejects(
      () => processUpload(new TextEncoder().encode("hello"), CODECS),
      UnsupportedImage,
    );
  });

  test("an upload past the size cap is refused before decoding", async () => {
    await assert.rejects(
      () => processUpload(new Uint8Array(5_000_001), CODECS),
      UnsupportedImage,
    );
  });

  // Builds a small PNG, then overwrites its IHDR width and height fields
  // with much larger values, leaving the chunk's CRC unchanged.
  test("a small file declaring a huge surface is refused before decoding", async () => {
    const png = makePng(4, 4);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, 20000); // IHDR width
    view.setUint32(20, 20000); // IHDR height
    assert.ok(png.byteLength < 5_000_000);
    assert.ok(20000 * 20000 > MAX_DECODED_PIXELS);
    await assert.rejects(() => processUpload(png, CODECS), UnsupportedImage);
  });

  test("a JPEG's size is read from its SOF, past the segments before it", async () => {
    await assert.rejects(
      () => processUpload(makeJpegHeader(12000, 12000), CODECS),
      (exc: Error) => exc instanceof UnsupportedImage && /decodes to more than/.test(exc.message),
    );
    const small = await processUpload(makeJpegHeader(640, 480), CODECS).then(
      () => null,
      (exc: Error) => exc,
    );
    if (small !== null) {
      assert.doesNotMatch(small.message, /decodes to more than|unreadable/);
    }
  });

  test("a source right up against the pixel cap is not refused by the guard", async () => {
    // 3000x4000 is exactly 12,000,000 pixels. The IHDR is set to this size
    // while the pixel data underneath stays 4x4.
    const png = makePng(4, 4);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, 3000);
    view.setUint32(20, 4000);
    const outcome = await processUpload(png, CODECS).then(
      () => null,
      (exc: Error) => exc,
    );
    if (outcome !== null) {
      assert.doesNotMatch(outcome.message, /decodes to more than/);
    }
  });
});
