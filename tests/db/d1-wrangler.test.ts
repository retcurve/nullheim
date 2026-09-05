/**
 * Tests for `literal`, which turns a value into an inlined SQL literal, and
 * for `openD1Wrangler`, which shells out to `wrangler d1 execute`. The
 * `wrangler` process is replaced with a fake runner that records each
 * invocation's args and returns canned output.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { literal, openD1Wrangler } from "../../src/db/d1-wrangler.ts";
import type { WranglerRun } from "../../src/wrangler-cli.ts";

describe("inlining a SQL literal", () => {
  test("strings are quoted and internal quotes doubled", () => {
    assert.equal(literal("img_abc"), "'img_abc'");
    assert.equal(literal("O'Brien"), "'O''Brien'");
    assert.equal(literal("'; DROP TABLE sectors; --"), "'''; DROP TABLE sectors; --'");
    assert.equal(literal(""), "''");
  });

  test("numbers, booleans and null", () => {
    assert.equal(literal(0), "0");
    assert.equal(literal(-1.5), "-1.5");
    assert.equal(literal(1788547321.814), "1788547321.814");
    assert.equal(literal(true), "1");
    assert.equal(literal(false), "0");
    assert.equal(literal(null), "NULL");
    assert.equal(literal(undefined), "NULL");
  });

  test("anything it has not thought about throws rather than being coerced", () => {
    for (const value of [new Date(), { a: 1 }, [1, 2], 10n, new Uint8Array([1]), NaN, Infinity]) {
      assert.throws(() => literal(value), `${String(value)} must not inline silently`);
    }
  });
});

/** Fakes `wrangler`, recording each call's args and returning `results` as its JSON stdout. */
function fakeWrangler(results: unknown[] = [{ success: true, meta: { changes: 1, last_row_id: 0 } }]) {
  const calls: (readonly string[])[] = [];
  const run: WranglerRun = async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify(results), stderr: "", code: 0 };
  };
  return { calls, run };
}

describe("the wrangler adapter", () => {
  test("a single statement inlines its parameter", async () => {
    const { calls, run } = fakeWrangler([{ success: true, results: [{ a: 1 }] }]);
    await openD1Wrangler({ database: "DB" }, run).all("SELECT * FROM images WHERE image_key = ?", ["img_x"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]!.slice(0, 5),
      ["d1", "execute", "DB", "--remote", "--json"],
    );
    assert.equal(calls[0]!.at(-1), "SELECT * FROM images WHERE image_key = 'img_x'");
  });

  test("--env is passed through when given, and omitted otherwise", async () => {
    const { calls, run } = fakeWrangler();
    await openD1Wrangler({ database: "DB", env: "preview" }, run).run("SELECT 1");
    assert.ok(calls[0]!.includes("--env"));
    assert.equal(calls[0]![calls[0]!.indexOf("--env") + 1], "preview");

    const bare = fakeWrangler();
    await openD1Wrangler({ database: "DB" }, bare.run).run("SELECT 1");
    assert.ok(!bare.calls[0]!.includes("--env"));
  });

  test("a batch inlines its parameters, in order, as one command", async () => {
    const { calls, run } = fakeWrangler([
      { success: true, meta: { changes: 1, last_row_id: 0 } },
      { success: true, meta: { changes: 2, last_row_id: 0 } },
    ]);
    const results = await openD1Wrangler({ database: "DB" }, run).batch([
      {
        sql: "UPDATE images SET state = 'rejected', reviewed_at = ? WHERE image_key = ?",
        params: [1788547321.814, "img_x"],
      },
      { sql: "UPDATE sectors SET image = NULL WHERE image = ?", params: ["/v1/images/img_x"] },
    ]);
    assert.equal(calls.length, 1, "a batch is one wrangler call, not one per statement");
    assert.equal(
      calls[0]!.at(-1),
      "UPDATE images SET state = 'rejected', reviewed_at = 1788547321.814 WHERE image_key = 'img_x'" +
        ";\nUPDATE sectors SET image = NULL WHERE image = '/v1/images/img_x'",
    );
    assert.deepEqual(
      results.map((r) => r.changes),
      [1, 2],
    );
  });

  test("a question mark inside a quoted string is not a placeholder", async () => {
    const { run } = fakeWrangler([{ success: true }, { success: true }]);
    await openD1Wrangler({ database: "DB" }, run).batch([
      { sql: "UPDATE t SET note = 'what?' WHERE k = ?", params: ["k1"] },
      { sql: "SELECT 1", params: [] },
    ]);
  });

  test("a non-JSON-array response (wrangler's own error shape) throws with its detail", async () => {
    const run: WranglerRun = async () => ({
      stdout: JSON.stringify({ error: { text: "no such table: images" } }),
      stderr: "",
      code: 1,
    });
    await assert.rejects(
      () => openD1Wrangler({ database: "DB" }, run).run("SELECT 1"),
      /no such table: images/,
    );
  });

  test("the underlying reason inside `error.notes` is included, not just the wrapper text", async () => {
    const run: WranglerRun = async () => ({
      stdout: JSON.stringify({
        error: {
          text: "A request to the Cloudflare API (...) failed.",
          notes: [{ text: "no such table: images: SQLITE_ERROR [code: 7500]" }],
        },
      }),
      stderr: "",
      code: 1,
    });
    await assert.rejects(
      () => openD1Wrangler({ database: "DB" }, run).run("SELECT 1"),
      /no such table: images: SQLITE_ERROR/,
    );
  });

  test("output that isn't parseable JSON at all throws with the raw exit detail", async () => {
    const run: WranglerRun = async () => ({ stdout: "", stderr: "not logged in", code: 1 });
    await assert.rejects(
      () => openD1Wrangler({ database: "DB" }, run).run("SELECT 1"),
      /not logged in/,
    );
  });

  test("exec() is not available", async () => {
    await assert.rejects(() => openD1Wrangler({ database: "DB" }, fakeWrangler().run).exec("CREATE TABLE t (a)"));
  });
});
