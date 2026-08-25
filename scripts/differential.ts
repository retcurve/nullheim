/**
 * Differential harness: the Python implementation against the TypeScript one.
 *
 * Both servers are started fresh and in-memory, then driven through an identical
 * scripted sequence of HTTP requests. Every response is normalised — ids, tokens
 * and timestamps replaced by stable placeholders in order of first appearance —
 * and the two transcripts are compared entry by entry.
 *
 * Allocation is the one thing that cannot be driven identically: the two
 * implementations use different random generators on purpose, so a claim lands
 * on a different square in each. The script works around that with only the
 * public API — it claims and releases until it is handed the coordinate it
 * wanted — so both worlds are built in exactly the same shape and every later
 * read is comparable.
 *
 *   node scripts/differential.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const LEASE_SECONDS = 900;

interface Entry {
  label: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
  /**
   * How many allocation retries the harness had performed when this response
   * was captured. Each retry releases a claim, so this is exactly the amount by
   * which the harness has inflated `stats.claims_released` — subtracted back out
   * during comparison so the counter is still checked rather than ignored.
   */
  retriesAtCapture: number;
}

interface Server {
  name: string;
  base: string;
  process: ChildProcess;
}

// --- normalisation ----------------------------------------------------------
//
// Anything minted from randomness or read off the clock differs between the two
// runs by definition. Each distinct value is replaced by a placeholder numbered
// in order of first appearance, so a transcript still proves that the *same*
// id appeared in the same places — only its spelling is discarded.

const VOLATILE_PATTERNS: [RegExp, string][] = [
  [/\bagent_[0-9a-f]{16}\b/g, "AGENT"],
  [/\bclaim_[0-9a-f]{16}\b/g, "CLAIM"],
  [/\bsec_[0-9a-f]{16}\b/g, "SEC"],
  [/\bobj_[0-9a-f]{16}\b/g, "OBJ"],
];

// Bearer tokens are matched by exact value, never by pattern. A base64url token
// can begin or end with "-" or "_", where \b does not mean what it looks like it
// means, so a length-based pattern matched some tokens and not others depending
// on what randomness produced — which silently drifted the placeholder numbering
// between the two runs and reported a difference that did not exist.
const SECRET_FIELDS = new Set(["token"]);

/** Fields carrying a wall-clock instant, which can never match across runs. */
const TIME_FIELDS = new Set([
  "created_at",
  "baked_at",
  "expires_at",
  "next_contribution_at",
  "saved_at",
]);

/** Fields carrying a measured duration, which drifts by milliseconds. */
const DURATION_FIELDS = new Set(["expires_in", "cooldown_remaining"]);

/**
 * The one message whose text cannot match: it is the JSON parser's own prose,
 * and CPython's `json` module and V8 word it differently. The status (400) and
 * the machine-readable code (`malformed_json`) are compared strictly as usual —
 * only the parser's explanation is collapsed, since an agent is told to key on
 * the code, and reproducing CPython's wording inside V8 would be absurd.
 */
const PARSER_PROSE = /^body is not valid JSON: .*$/s;

class Normaliser {
  #seen = new Map<string, string>();
  /** How many times a known divergence was collapsed, reported at the end. */
  readonly collapsed = new Map<string, number>();

  #note(what: string): void {
    this.collapsed.set(what, (this.collapsed.get(what) ?? 0) + 1);
  }

  #placeholder(value: string, kind: string): string {
    const existing = this.#seen.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const index = [...this.#seen.values()].filter((v) => v.startsWith(`<${kind}_`)).length + 1;
    const placeholder = `<${kind}_${index}>`;
    this.#seen.set(value, placeholder);
    return placeholder;
  }

  /** Exact secret values seen so far, longest first so no prefix shadows one. */
  #secrets: string[] = [];

  registerSecret(value: string): void {
    if (!this.#secrets.includes(value)) {
      this.#secrets.push(value);
      this.#secrets.sort((a, b) => b.length - a.length);
    }
  }

  text(value: string): string {
    if (PARSER_PROSE.test(value)) {
      this.#note("json parser prose");
      return "body is not valid JSON: <parser message>";
    }
    let out = value;
    for (const secret of this.#secrets) {
      if (out.includes(secret)) {
        out = out.split(secret).join(this.#placeholder(secret, "TOKEN"));
      }
    }
    for (const [pattern, kind] of VOLATILE_PATTERNS) {
      out = out.replace(pattern, (match) => this.#placeholder(match, kind));
    }
    return out;
  }

  value(node: unknown, field?: string, retries = 0): unknown {
    if (typeof node === "string") {
      if (field !== undefined && SECRET_FIELDS.has(field)) {
        this.registerSecret(node);
      }
      return this.text(node);
    }
    if (typeof node === "number") {
      if (field !== undefined && TIME_FIELDS.has(field)) {
        return "<TIME>";
      }
      if (field !== undefined && DURATION_FIELDS.has(field)) {
        return "<DURATION>";
      }
      if (field === "claims_released") {
        // Discount the harness's own releases; see Entry.retriesAtCapture.
        if (retries > 0) {
          this.#note("harness claim releases discounted");
        }
        return node - retries;
      }
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item) => this.value(item, undefined, retries));
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort()) {
        out[key] = this.value((node as Record<string, unknown>)[key], key, retries);
      }
      return out;
    }
    return node;
  }
}

// --- the driver -------------------------------------------------------------

class Driver {
  readonly entries: Entry[] = [];
  readonly #base: string;
  #retries = 0;

  constructor(base: string) {
    this.#base = base;
  }

  get retries(): number {
    return this.#retries;
  }

  /** Issue a request and record it in the transcript. */
  async call(
    label: string,
    method: string,
    path: string,
    options: { body?: unknown; rawBody?: string; token?: string; accept?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const result = await this.raw(method, path, options);
    this.entries.push({
      label,
      method,
      path,
      status: result.status,
      body: result.body,
      retriesAtCapture: this.#retries,
    });
    return result;
  }

  /** Issue a request without recording it — used for allocation retries. */
  async raw(
    method: string,
    path: string,
    options: { body?: unknown; rawBody?: string; token?: string; accept?: string } = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? "application/json",
    };
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = JSON.stringify(options.body);
    } else if (options.rawBody !== undefined) {
      payload = options.rawBody;
    }
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    const response = await fetch(
      `${this.#base}${path}`,
      payload === undefined ? { method, headers } : { method, headers, body: payload },
    );
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    return { status: response.status, body };
  }

  /**
   * Claim until the frontier hands over `target`, releasing anything else.
   *
   * The retries are deliberately kept out of the transcript: how many attempts
   * each implementation needs is a property of its random generator, which the
   * port never promised to reproduce. What goes on the record is the successful
   * claim, which both sides reach with the same world in the same shape.
   */
  async claimAt(label: string, token: string, target: [number, number]): Promise<any> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { status, body } = await this.raw("POST", "/v1/claims", { token });
      if (status !== 201) {
        throw new Error(`${label}: claim refused: ${JSON.stringify(body)}`);
      }
      const [x, y] = body.coordinate;
      if (x === target[0] && y === target[1]) {
        this.entries.push({
          label,
          method: "POST",
          path: "/v1/claims",
          status,
          body,
          retriesAtCapture: this.#retries,
        });
        return body;
      }
      this.#retries += 1;
      await this.raw("DELETE", `/v1/claims/${body.claim.claim_id}`, { token });
    }
    throw new Error(`${label}: never allocated ${JSON.stringify(target)}`);
  }
}

// --- the script both implementations run ------------------------------------

function sector(at: [number, number], overrides: Record<string, unknown> = {}) {
  return {
    coordinate: at,
    title: "A Place",
    short_description: "A doorway, and something past it.",
    long_description: "It is a place, and it is here.",
    ...overrides,
  };
}

async function script(d: Driver): Promise<void> {
  // --- the world as found, before anything is written ---------------------
  await d.call("root:markdown", "GET", "/", { accept: "*/*" });
  await d.call("root:json", "GET", "/");
  await d.call("health:empty", "GET", "/v1/health");
  await d.call("spec", "GET", "/v1/spec");
  await d.call("map:genesis", "GET", "/v1/map");
  await d.call("sector:genesis", "GET", "/v1/sectors/0/0");
  await d.call("sector:missing", "GET", "/v1/sectors/0/9");
  await d.call("sector:negative", "GET", "/v1/sectors/-1/-1");
  await d.call("object:missing", "GET", "/v1/objects/obj_nope");
  await d.call("route:unknown", "GET", "/v1/nonsense");

  // --- auth refusals ------------------------------------------------------
  await d.call("claim:no-token", "POST", "/v1/claims");
  await d.call("claim:bad-token", "POST", "/v1/claims", { token: "not-a-real-token" });
  await d.call("me:no-token", "GET", "/v1/agents/me");
  await d.call("objects:no-token", "POST", "/v1/objects", { body: { parent_id: "x" } });

  // --- registration -------------------------------------------------------
  const first = (await d.call("register:first", "POST", "/v1/agents/register", {
    body: { label: "first" },
  })).body.token;
  await d.call("register:no-label", "POST", "/v1/agents/register", { body: {} });
  await d.call("register:bad-label", "POST", "/v1/agents/register", { body: { label: 17 } });

  // --- an agent with no sector -------------------------------------------
  await d.call("me:unsettled", "GET", "/v1/agents/me", { token: first });
  await d.call("objects:no-sector", "POST", "/v1/objects", {
    body: { parent_id: "sec_whatever", title: "A Thing", description: "d" },
    token: first,
  });

  // --- claiming -----------------------------------------------------------
  const claim = await d.claimAt("claim:first", first, [0, 1]);
  const claimId = claim.claim.claim_id;
  await d.call("claim:reread", "GET", `/v1/claims/${claimId}`, { token: first });
  await d.call("claim:second-refused", "POST", "/v1/claims", { token: first });
  await d.call("claim:missing", "GET", "/v1/claims/claim_0000000000000000", { token: first });

  // --- dry runs, every rejection the validator can produce ---------------
  await d.call("validate:clean", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1]),
    token: first,
  });
  await d.call("validate:blank-title", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { title: "   " }),
    token: first,
  });
  await d.call("validate:wrong-coordinate", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([9, 9]),
    token: first,
  });
  await d.call("validate:too-long", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { short_description: "x".repeat(301) }),
    token: first,
  });
  // Astral characters: one code point, two UTF-16 units. A title of exactly the
  // limit must pass and one past it must fail, in both implementations — this is
  // the code-point hazard, checked end to end over the wire.
  await d.call("validate:astral-at-limit", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { title: "𝔊".repeat(64) }),
    token: first,
  });
  await d.call("validate:astral-over-limit", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { title: "𝔊".repeat(65) }),
    token: first,
  });
  await d.call("validate:unknown-field", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { exits: [{ direction: "north" }] }),
    token: first,
  });
  await d.call("validate:control-chars", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { long_description: "ab" }),
    token: first,
  });
  await d.call("validate:bad-coordinate-shape", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { coordinate: [0, 1, 0] }),
    token: first,
  });
  await d.call("validate:non-object", "POST", `/v1/claims/${claimId}/validate`, {
    body: ["not", "an", "object"],
    token: first,
  });
  await d.call("validate:null-text", "POST", `/v1/claims/${claimId}/validate`, {
    body: sector([0, 1], { title: null }),
    token: first,
  });

  // --- malformed transport ------------------------------------------------
  await d.call("submit:malformed-json", "POST", `/v1/claims/${claimId}/sector`, {
    rawBody: "{nope",
    token: first,
  });
  await d.call("submit:oversized", "POST", `/v1/claims/${claimId}/sector`, {
    rawBody: "x".repeat(200_000),
    token: first,
  });

  // --- a rejected bake, then a clean one ---------------------------------
  await d.call("submit:rejected", "POST", `/v1/claims/${claimId}/sector`, {
    body: sector([9, 9]),
    token: first,
  });
  await d.call("submit:baked", "POST", `/v1/claims/${claimId}/sector`, {
    body: sector([0, 1], { title: "The Moth Orangery" }),
    token: first,
  });
  await d.call("submit:again", "POST", `/v1/claims/${claimId}/sector`, {
    body: sector([0, 1]),
    token: first,
  });
  await d.call("claim:after-settling", "POST", "/v1/claims", { token: first });
  await d.call("me:settled", "GET", "/v1/agents/me", { token: first });

  // --- exits appear on both sides ----------------------------------------
  await d.call("sector:genesis-with-neighbour", "GET", "/v1/sectors/0/0");
  await d.call("sector:the-new-one", "GET", "/v1/sectors/0/1");
  await d.call("map:two-sectors", "GET", "/v1/map");

  // --- objects ------------------------------------------------------------
  const sectorId = (await d.call("me:for-sector-id", "GET", "/v1/agents/me", { token: first }))
    .body.sector.sector_id;

  await d.call("object:validate-clean", "POST", "/v1/objects/validate", {
    body: { parent_id: sectorId, title: "Brass Can", description: "Dented." },
    token: first,
  });
  await d.call("object:validate-no-parent", "POST", "/v1/objects/validate", {
    body: { parent_id: "obj_nope", title: "A Thing", description: "d" },
    token: first,
  });
  await d.call("object:validate-null-parent", "POST", "/v1/objects/validate", {
    body: { parent_id: null, title: "A Thing", description: "d" },
    token: first,
  });
  await d.call("object:validate-unknown-field", "POST", "/v1/objects/validate", {
    body: { parent_id: sectorId, title: "t", description: "d", weight_class: "light" },
    token: first,
  });

  const can = (await d.call("object:place-can", "POST", "/v1/objects", {
    body: { parent_id: sectorId, title: "Brass Can", description: "Dented, unpolished." },
    token: first,
  })).body.object.object_id;
  await d.call("object:place-key", "POST", "/v1/objects", {
    body: { parent_id: can, title: "Small Key", description: "Bright where handled." },
    token: first,
  });
  await d.call("object:place-crate", "POST", "/v1/objects", {
    body: { parent_id: sectorId, title: "Crate", description: "Stencilled." },
    token: first,
  });

  await d.call("object:read-can", "GET", `/v1/objects/${can}`);
  await d.call("sector:with-objects", "GET", "/v1/sectors/0/1");
  await d.call("me:with-object-tree", "GET", "/v1/agents/me", { token: first });

  // --- a second agent, and cross-sector ownership -------------------------
  const second = (await d.call("register:second", "POST", "/v1/agents/register", {
    body: { label: "second" },
  })).body.token;
  const secondClaim = await d.claimAt("claim:second", second, [1, 0]);
  await d.call("claim:not-yours", "GET", `/v1/claims/${claimId}`, { token: second });
  await d.call("submit:second", "POST", `/v1/claims/${secondClaim.claim.claim_id}/sector`, {
    body: sector([1, 0], { title: "Cold Row" }),
    token: second,
  });
  const secondSectorId = (await d.call("me:second", "GET", "/v1/agents/me", { token: second }))
    .body.sector.sector_id;
  await d.call("object:foreign-parent", "POST", "/v1/objects", {
    body: { parent_id: can, title: "Trespass", description: "d" },
    token: second,
  });
  await d.call("object:second-own", "POST", "/v1/objects", {
    body: { parent_id: secondSectorId, title: "Shutter", description: "d" },
    token: second,
  });

  // --- release path -------------------------------------------------------
  const third = (await d.call("register:third", "POST", "/v1/agents/register", {
    body: { label: "third" },
  })).body.token;
  const thirdClaim = await d.claimAt("claim:third", third, [0, -1]);
  await d.call("claim:release", "DELETE", `/v1/claims/${thirdClaim.claim.claim_id}`, {
    token: third,
  });
  await d.call("claim:release-again", "DELETE", `/v1/claims/${thirdClaim.claim.claim_id}`, {
    token: third,
  });

  // --- the finished world -------------------------------------------------
  await d.call("map:final", "GET", "/v1/map");
  await d.call("health:final", "GET", "/v1/health");
  await d.call("sector:final-genesis", "GET", "/v1/sectors/0/0");
  await d.call("sector:final-orangery", "GET", "/v1/sectors/0/1");
  await d.call("sector:final-cold-row", "GET", "/v1/sectors/1/0");
}

/**
 * The rate-limited paths, which the main script cannot reach.
 *
 * It runs with no cooldown so that objects can be placed at all, which means the
 * 429 never fires there. A sabotage run proved that gap was real — changing the
 * cooldown refusal's status code went unnoticed until this scenario existed.
 */
async function cooldownScript(d: Driver): Promise<void> {
  const token = (await d.call("cooldown:register", "POST", "/v1/agents/register", {
    body: { label: "waiting" },
  })).body.token;

  await d.call("cooldown:spec", "GET", "/v1/spec");

  const claim = await d.claimAt("cooldown:claim", token, [0, 1]);
  await d.call("cooldown:submit", "POST", `/v1/claims/${claim.claim.claim_id}/sector`, {
    body: sector([0, 1], { title: "The Waiting Room" }),
    token,
  });

  // Freshly settled: the clock is running, so this must be a 429 and not a 422.
  await d.call("cooldown:object-refused", "POST", "/v1/objects", {
    body: { parent_id: "sec_whatever", title: "Too Soon", description: "d" },
    token,
  });
  await d.call("cooldown:me", "GET", "/v1/agents/me", { token });

  // A dry run is not rate-limited, and must still answer normally.
  await d.call("cooldown:validate-still-works", "POST", "/v1/objects/validate", {
    body: { parent_id: "obj_nope", title: "t", description: "d" },
    token,
  });
}

// --- process management -----------------------------------------------------

async function waitForHealth(base: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`${base} did not become healthy`);
}

async function start(
  name: string,
  command: string,
  leadingArgs: string[],
  port: number,
  cooldownSeconds: number,
  cwd: string,
): Promise<Server> {
  const child = spawn(
    command,
    [
      ...leadingArgs,
      "serve",
      "--port",
      String(port),
      "--lease-seconds",
      String(LEASE_SECONDS),
      "--cooldown-seconds",
      String(cooldownSeconds),
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base);
  return { name, base, process: child };
}

// The reference implementation now lives under reference/ — see
// docs/PORTING.md — so `python -m mosaic` must run with that as its cwd for the
// package to resolve, while the TypeScript server still runs from the repo root.
const ROOT_DIR = new URL("..", import.meta.url).pathname;
const REFERENCE_DIR = new URL("../reference", import.meta.url).pathname;

const startPython = (port: number, cooldown: number) =>
  start("python", "python3", ["-m", "mosaic"], port, cooldown, REFERENCE_DIR);

const startTypeScript = (port: number, cooldown: number) =>
  start("typescript", "node", ["src/cli.ts"], port, cooldown, ROOT_DIR);

function stop(server: Server): void {
  server.process.kill("SIGKILL");
}

// --- comparison -------------------------------------------------------------

function compare(
  pythonEntries: Entry[],
  tsEntries: Entry[],
): { problems: string[]; collapsed: Map<string, number> } {
  const problems: string[] = [];
  if (pythonEntries.length !== tsEntries.length) {
    problems.push(
      `transcripts differ in length: python ${pythonEntries.length}, ` +
        `typescript ${tsEntries.length}`,
    );
  }

  const pythonNorm = new Normaliser();
  const tsNorm = new Normaliser();

  const count = Math.min(pythonEntries.length, tsEntries.length);
  for (let index = 0; index < count; index += 1) {
    const py = pythonEntries[index]!;
    const ts = tsEntries[index]!;
    if (py.label !== ts.label) {
      problems.push(`#${index} label drift: ${py.label} vs ${ts.label}`);
      continue;
    }
    if (py.status !== ts.status) {
      problems.push(`#${index} ${py.label}: status ${py.status} vs ${ts.status}`);
    }
    const pyBody = JSON.stringify(
      pythonNorm.value(py.body, undefined, py.retriesAtCapture),
      null,
      2,
    );
    const tsBody = JSON.stringify(
      tsNorm.value(ts.body, undefined, ts.retriesAtCapture),
      null,
      2,
    );
    if (pyBody !== tsBody) {
      problems.push(`#${index} ${py.label}: body differs\n${diffLines(pyBody, tsBody)}`);
    }
  }
  return { problems, collapsed: pythonNorm.collapsed };
}

function diffLines(a: string, b: string): string {
  const left = a.split("\n");
  const right = b.split("\n");
  const out: string[] = [];
  const limit = Math.max(left.length, right.length);
  let shown = 0;
  for (let i = 0; i < limit && shown < 14; i += 1) {
    if (left[i] !== right[i]) {
      out.push(`    python     | ${left[i] ?? "(absent)"}`);
      out.push(`    typescript | ${right[i] ?? "(absent)"}`);
      shown += 1;
    }
  }
  return out.join("\n");
}

// --- main -------------------------------------------------------------------

interface Scenario {
  name: string;
  cooldownSeconds: number;
  port: number;
  run: (d: Driver) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  { name: "the world being built", cooldownSeconds: 0, port: 8911, run: script },
  { name: "the contribution clock", cooldownSeconds: 3600, port: 8921, run: cooldownScript },
];

async function runScenario(scenario: Scenario): Promise<{ problems: string[]; count: number; collapsed: Map<string, number> }> {
  let python: Server | null = null;
  let typescript: Server | null = null;
  try {
    python = await startPython(scenario.port, scenario.cooldownSeconds);
    typescript = await startTypeScript(scenario.port + 1, scenario.cooldownSeconds);

    const pyDriver = new Driver(python.base);
    await scenario.run(pyDriver);

    const tsDriver = new Driver(typescript.base);
    await scenario.run(tsDriver);

    const { problems, collapsed } = compare(pyDriver.entries, tsDriver.entries);
    return { problems, count: pyDriver.entries.length, collapsed };
  } finally {
    if (python) stop(python);
    if (typescript) stop(typescript);
  }
}

async function main(): Promise<number> {
  let failed = 0;
  let total = 0;

  for (const scenario of SCENARIOS) {
    console.log(`\n── ${scenario.name} (cooldown ${scenario.cooldownSeconds}s) ──`);
    const { problems, count, collapsed } = await runScenario(scenario);
    total += count;

    if (collapsed.size > 0) {
      for (const [what, times] of collapsed) {
        console.log(`  known divergence collapsed: ${what} (${times}×)`);
      }
    }

    if (problems.length === 0) {
      console.log(`  ✓ ${count} responses agree`);
    } else {
      failed += problems.length;
      console.log(`  ✗ ${problems.length} difference(s):\n`);
      for (const problem of problems) {
        console.log(`    ${problem}\n`);
      }
    }
  }

  console.log(
    failed === 0
      ? `\n✓ the two implementations agree on all ${total} responses`
      : `\n✗ ${failed} difference(s) across ${total} responses`,
  );
  return failed === 0 ? 0 : 1;
}

/**
 * The oversized-body request is answered with 413 and a hang-up *before* the
 * client has finished writing its 200KB — that is the point of it, in both
 * implementations. The response is read fine, but the client's write side then
 * fails asynchronously, after the await has already resolved. Only those two
 * codes are tolerated; anything else still takes the process down.
 */
process.on("unhandledRejection", (reason) => {
  const code = (reason as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (reason as { code?: string })?.code;
  if (code === "EPIPE" || code === "ECONNRESET") {
    return;
  }
  console.error(reason);
  process.exit(2);
});

main().then(
  (code) => process.exit(code),
  (exc) => {
    console.error(exc);
    process.exit(2);
  },
);
