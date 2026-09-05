/**
 * Loads `public/app.js` as text and extracts `escapeHtml` and `toHtml` from
 * it by source, then runs them directly, so the test exercises the same
 * code the server serves.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const APP_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js"),
  "utf-8",
);

/** Returns the source text of one top-level function in the file, from `  function name(` to the matching `\n  }`. */
function extract(name: string): string {
  const start = APP_JS.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `public/app.js no longer defines ${name}()`);
  const end = APP_JS.indexOf("\n  }\n", start);
  assert.notEqual(end, -1, `could not find the end of ${name}() in public/app.js`);
  return APP_JS.slice(start, end + 4);
}

const { escapeHtml, toHtml } = new Function(
  `${extract("escapeHtml")}\n${extract("toHtml")}\nreturn { escapeHtml, toHtml };`,
)() as { escapeHtml: (text: string) => string; toHtml: (text: string) => string };

describe("the frontend's escaping of agent-written text", () => {
  test("markup in a submission is inert", () => {
    const html = toHtml('<img src=x onerror="alert(1)">');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  test("quotes never survive as themselves", () => {
    assert.equal(escapeHtml(`he said "no" — it's here`), "he said &quot;no&quot; — it&#39;s here");
  });

  test("a URL is never turned into a link", () => {
    const html = toHtml('go to https://x.tld/a"onmouseover="alert(1) and look');
    assert.doesNotMatch(html, /<a\b/);
    assert.doesNotMatch(html, /href/);
    // The URL text is still present in the output, unescaped-looking characters aside.
    assert.match(html, /https:\/\/x\.tld\/a&quot;onmouseover=&quot;alert\(1\)/);
  });

  test("no agent text reaches an attribute at all", () => {
    // Counts the quote characters in the output: only the function's own
    // `class="title"` attribute should contribute any.
    const html = toHtml('##Exits## and https://x.tld/?a="b" and **bold**');
    assert.equal((html.match(/"/g) ?? []).length, 2);
    assert.match(html, /<strong class="title">Exits<\/strong>/);
  });

  test("the conventions it exists to render still render", () => {
    assert.match(toHtml("**bold**"), /<strong>bold<\/strong>/);
    assert.match(toHtml("##Exits##"), /<strong class="title">Exits<\/strong>/);
    assert.match(toHtml("__under__"), /<u>under<\/u>/);
    assert.equal(toHtml("see https://x.tld/page"), "see https://x.tld/page");
  });
});
