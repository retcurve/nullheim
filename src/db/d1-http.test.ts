/**
 * Tests for `literal`, which turns a value into an inlined SQL literal, and
 * for `openD1Http().batch`, which inlines a statement's parameters before
 * sending it. Requests are captured with a fake `fetch`.
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { literal, openD1Http } from "./d1-http.ts";

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

/** Replaces global fetch with a stub that records each request body and returns `results`. */
function fakeFetch(results: unknown[] = [{ success: true, meta: { changes: 1, last_row_id: 0 } }]) {
  const sent: { sql: string; params?: unknown[] }[] = [];
  const fetcher = mock.method(globalThis, "fetch", async (_url: unknown, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, result: results }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return { sent, restore: () => fetcher.mock.restore() };
}

const target = { accountId: "acct", databaseId: "dbid", token: "tok" };

describe("the REST adapter", () => {
  test("a single statement sends real bound parameters, never an inlined one", async () => {
    const { sent, restore } = fakeFetch([{ success: true, results: [{ a: 1 }] }]);
    try {
      await openD1Http(target).all("SELECT * FROM images WHERE image_key = ?", ["img_x"]);
    } finally {
      restore();
    }
    assert.deepEqual(sent[0], { sql: "SELECT * FROM images WHERE image_key = ?", params: ["img_x"] });
  });

  test("a batch inlines its parameters, in order, one statement per placeholder run", async () => {
    const { sent, restore } = fakeFetch([
      { success: true, meta: { changes: 1, last_row_id: 0 } },
      { success: true, meta: { changes: 2, last_row_id: 0 } },
    ]);
    let results;
    try {
      results = await openD1Http(target).batch([
        {
          sql: "UPDATE images SET state = 'rejected', reviewed_at = ? WHERE image_key = ?",
          params: [1788547321.814, "img_x"],
        },
        { sql: "UPDATE sectors SET image = NULL WHERE image = ?", params: ["/v1/images/img_x"] },
      ]);
    } finally {
      restore();
    }
    assert.equal(sent.length, 1, "a batch is one request, not one per statement");
    assert.equal(sent[0]!.params, undefined, "params and multiple statements cannot be combined");
    assert.equal(
      sent[0]!.sql,
      "UPDATE images SET state = 'rejected', reviewed_at = 1788547321.814 WHERE image_key = 'img_x'" +
        ";\nUPDATE sectors SET image = NULL WHERE image = '/v1/images/img_x'",
    );
    assert.deepEqual(
      results.map((r) => r.changes),
      [1, 2],
    );
  });

  test("a question mark inside a quoted string is not a placeholder", async () => {
    const { sent, restore } = fakeFetch([{ success: true }, { success: true }]);
    try {
      await openD1Http(target).batch([
        { sql: "UPDATE t SET note = 'what?' WHERE k = ?", params: ["k1"] },
        { sql: "SELECT 1", params: [] },
      ]);
    } finally {
      restore();
    }
    assert.equal(sent[0]!.sql.split(";\n")[0], "UPDATE t SET note = 'what?' WHERE k = 'k1'");
  });

  test("a placeholder count that disagrees with the parameters is refused", async () => {
    const { restore } = fakeFetch();
    try {
      await assert.rejects(
        () => openD1Http(target).batch([{ sql: "UPDATE t SET a = ? WHERE b = ?", params: ["only-one"] }]),
        /placeholders/,
      );
    } finally {
      restore();
    }
  });

  test("an API-level failure is an error even though the HTTP status is 200", async () => {
    const fetcher = mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: "no such table" }] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    try {
      await assert.rejects(() => openD1Http(target).run("SELECT 1"), /7500 no such table/);
    } finally {
      fetcher.mock.restore();
    }
  });

  test("exec refuses rather than running DDL against a deployed world", async () => {
    await assert.rejects(() => openD1Http(target).exec("DROP TABLE sectors"), /not available/);
  });
});
