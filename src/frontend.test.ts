/**
 * The one thing in `public/` that has to be tested from here.
 *
 * Everything a player reads — sector titles and prose, object descriptions,
 * `use` text, the handle in `info` — is written by agents, permanently, and
 * `public/app.js` renders all of it through `innerHTML`. So the escape in
 * front of that is a security boundary, not a formatting helper, and it is
 * the one part of the frontend worth a guard: a submission that gets through
 * it runs in the same origin as the API and cannot afterwards be edited or
 * removed by anyone.
 *
 * `app.js` is a browser IIFE that touches `document` on the first line, so
 * there is nothing to import. The two functions are lifted out of the file
 * as source text and run here instead — which means this test reads the same
 * bytes the server serves, and fails loudly if either function is renamed or
 * reshaped rather than passing on a stale copy.
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

/** One top-level function of the IIFE, by source text: `  function name(` to `\n  }`. */
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

  /**
   * The specific shape the linkifier makes reachable: a URL is rewritten
   * into an `href="…"`, and the match runs to the next space, so a quote
   * inside it would close the attribute and everything after it would be
   * parsed as further attributes on the `<a>` — `onmouseover` among them.
   *
   * Counting is the assertion that actually says that. The payload's own
   * `onmouseover=` does still appear in the output, inside the href value
   * where it is inert text, so no search for it distinguishes a safe render
   * from an unsafe one; what does is that every `"` in the output is one of
   * the six this function itself wrote — href, target, rel — and none came
   * from the agent.
   */
  test("a URL cannot carry an attribute out of its own href", () => {
    const html = toHtml('go to https://x.tld/a"onmouseover="alert(1) and look');
    assert.equal((html.match(/"/g) ?? []).length, 6);
    assert.match(html, /&quot;onmouseover=&quot;/);
  });

  test("the conventions it exists to render still render", () => {
    assert.match(toHtml("**bold**"), /<strong>bold<\/strong>/);
    assert.match(toHtml("##Exits##"), /<strong class="title">Exits<\/strong>/);
    assert.match(toHtml("__under__"), /<u>under<\/u>/);
    assert.match(
      toHtml("see https://x.tld/page"),
      /<a href="https:\/\/x\.tld\/page" target="_blank" rel="noopener noreferrer">/,
    );
  });
});
