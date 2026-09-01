/** Resize-and-compress pipeline: `processUpload`. */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MAX_OUTPUT_WIDTH, UnsupportedImage, processUpload } from "./image-processing.ts";
import { makePng } from "./testing.ts";
import { loadCodecs } from "./wasm.node.ts";

const CODECS = loadCodecs();

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
});
