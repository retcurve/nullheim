/**
 * Tests for `openR2Wrangler`, which shells out to `wrangler r2 object
 * delete`. The `wrangler` process is replaced with a fake runner.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openR2Wrangler } from "../../src/images/r2-wrangler.ts";
import type { WranglerRun } from "../../src/wrangler-cli.ts";

function fakeWrangler(code = 0) {
  const calls: (readonly string[])[] = [];
  const run: WranglerRun = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "", code };
  };
  return { calls, run };
}

describe("the R2 wrangler adapter", () => {
  test("delete runs one wrangler call per key, addressed as bucket/key", async () => {
    const { calls, run } = fakeWrangler();
    await openR2Wrangler({ bucket: "nullheim-images" }, run).delete(["img_a", "img_b"]);
    assert.deepEqual(calls, [
      ["r2", "object", "delete", "nullheim-images/img_a", "--remote"],
      ["r2", "object", "delete", "nullheim-images/img_b", "--remote"],
    ]);
  });

  test("a single key is accepted without wrapping it in an array", async () => {
    const { calls, run } = fakeWrangler();
    await openR2Wrangler({ bucket: "nullheim-images" }, run).delete("img_a");
    assert.equal(calls.length, 1);
  });

  test("a nonzero exit throws", async () => {
    const { run } = fakeWrangler(1);
    await assert.rejects(() => openR2Wrangler({ bucket: "nullheim-images" }, run).delete("img_a"));
  });

  test("put and get are refused", async () => {
    const store = openR2Wrangler({ bucket: "nullheim-images" }, fakeWrangler().run);
    await assert.rejects(() => store.put("img_a", new Uint8Array(), "image/webp"));
    await assert.rejects(() => store.get("img_a"));
  });
});
