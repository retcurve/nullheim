/**
 * Builds a mockup world snapshot for exercising the frontend at scale — the
 * map view in particular, which is unreadable to test by hand-registering a
 * dozen agents.
 *
 * Goes through the real engine (register, claim, submit) rather than writing
 * coordinates directly, so growth passes through the actual uniform-frontier
 * allocator in registry.ts. Laying sectors out by hand would produce a solid
 * block, and CLAUDE.md is explicit that a block is not what this world looks
 * like — see "Allocation is uniform over empty slots".
 *
 * Usage:
 *   node scripts/generate_mockup.ts [count] [out-path]
 *
 * Defaults to 1000 sectors written straight into `wrangler dev`'s own local
 * D1 file — found automatically under .wrangler/state — so `npm run dev`
 * (or dev:worker) picks up the result on its next request with no restart
 * and no separate --db flag. Pass an explicit out-path to write somewhere
 * else instead (e.g. for the Node CLI's `serve --db`).
 *
 * `wrangler dev` must have been run at least once first, to create that
 * local D1 file — and per CLAUDE.md's "the local SQLite file is still
 * single-process", stop it before running this script and restart it after,
 * so the two processes never hold the file open at the same time.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openSqlite } from "../src/db/sqlite.ts";
import { SCHEMA_SQL } from "../src/db/schema.node.ts";
import { Engine, ensureGenesis } from "../src/engine.ts";
import { openFsImages } from "../src/images/fs.ts";
import { loadPrompts } from "../src/prompts.node.ts";
import { Registry } from "../src/registry.ts";
import { WorldStore } from "../src/store.ts";
import { loadCodecs } from "../src/wasm.node.ts";

const TARGET_SECTORS = Number(process.argv[2] ?? 1000);
const OUT_PATH = process.argv[3] ?? findLocalD1File();

/**
 * `wrangler dev`'s local D1 simulator is a plain SQLite file — the same
 * schema as production, just applied via `wrangler d1 migrations apply
 * --local` instead of on Cloudflare — so node:sqlite can open and write to
 * it directly. Its name is an opaque hash Wrangler derives from the database
 * id, not something worth hardcoding, so it's found by listing the
 * directory instead: one real .sqlite file lives there alongside
 * Miniflare's own metadata.sqlite.
 */
function findLocalD1File(): string {
  const dir = new URL(
    "../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/",
    import.meta.url,
  ).pathname;
  if (!existsSync(dir)) {
    throw new Error(
      `no local D1 state at ${dir} — run \`npm run dev:worker\` once first ` +
        `so wrangler creates it, or pass an explicit out-path.`,
    );
  }
  const candidates = readdirSync(dir).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one local D1 database file in ${dir}, found ` +
        `${candidates.length} (${candidates.join(", ") || "none"}) — pass ` +
        `an explicit out-path instead.`,
    );
  }
  return join(dir, candidates[0]!);
}

const ADJECTIVES = [
  "Copper", "Salt", "Quiet", "Burnt", "Drowned", "Hollow", "Gilded", "Frozen",
  "Bruised", "Amber", "Rusted", "Broken", "Pale", "Velvet", "Ashen", "Wet",
  "Cracked", "Faded", "Iron", "Glass", "Tangled", "Forgotten", "Sunken",
  "Splintered", "Chalk", "Dusty", "Silver", "Withered", "Crooked", "Marrow",
];

const NOUNS = [
  "Foundry", "Orangery", "Reliquary", "Depot", "Chapel", "Archive", "Vault",
  "Aviary", "Cistern", "Menagerie", "Loft", "Bindery", "Conservatory",
  "Switchyard", "Refinery", "Scriptorium", "Aquarium", "Greenhouse",
  "Boilerhouse", "Pantry", "Workshop", "Observatory", "Cellar", "Warren",
  "Rookery", "Sanatorium", "Granary", "Icehouse", "Smokehouse", "Larder",
];

const PLACE_TEMPLATES = [
  (a: string, n: string) => `The ${a} ${n}`,
  (a: string, n: string) => `${a} ${n}`,
  (_a: string, n: string) => `The ${n} at the End`,
  (a: string, _n: string) => `${a} Row`,
];

const TEXTURES = [
  "the light comes in wrong, low and sideways",
  "everything still smells faintly of solder",
  "dust has settled into every seam",
  "the floor gives slightly underfoot, like it remembers weight",
  "somewhere behind the walls, something ticks on its own schedule",
  "the air is thick enough to taste, mineral and old",
  "nothing here has been moved in a long time",
  "a draft comes from a source nobody has found",
  "the corners hold a cold the rest of the room doesn't",
  "whatever was made here stopped being made mid-shift",
];

const OBJECTS_LEFT_BEHIND = [
  "a coil of wire gone green at the ends",
  "a ledger, its pages swollen with old damp",
  "a single glove, palm worn through",
  "a stack of crates nobody has claimed",
  "a chair pushed back as if someone meant to return",
  "a jar of something that was once liquid",
  "a length of rail with no track either side of it",
  "a lantern with no oil left to burn",
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** mulberry32 — deterministic, so the same count reproduces the same world. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSector(rng: () => number, coordinate: [number, number], index: number) {
  const adjective = pick(rng, ADJECTIVES);
  const noun = pick(rng, NOUNS);
  const template = pick(rng, PLACE_TEMPLATES);
  const title = template(adjective, noun);

  const shortDescription =
    `A glimpse of ${adjective.toLowerCase()} ${noun.toLowerCase()} through the gap in the door — ` +
    `${pick(rng, TEXTURES)}.`;

  const opening = pick(rng, TEXTURES);
  const longDescription =
    `Sector #${index}: ${title}. ${opening[0]!.toUpperCase()}${opening.slice(1)}, ` +
    `and ${pick(rng, TEXTURES)}. Someone left ${pick(rng, OBJECTS_LEFT_BEHIND)} behind, and it hasn't ` +
    `moved since. This mockup sector exists only to test the map view at scale, at coordinate ` +
    `(${coordinate[0]}, ${coordinate[1]}).`;

  return {
    coordinate,
    title,
    short_description: shortDescription,
    long_description: longDescription,
  };
}

/**
 * `CREATE TABLE IF NOT EXISTS` (below) is a no-op against an already-baked
 * database, so a local D1 file that predates a later migration — like
 * 0002_add_image.sql's `image` columns — stays short those columns even
 * after SCHEMA_SQL runs. store.ts's INSERTs always name `image` explicitly,
 * so a stale column set fails on the first sector, not with a helpful
 * error. Bring it up to schema.sql's current shape by hand, the same way
 * `wrangler d1 migrations apply --local` would.
 */
async function patchMissingImageColumns(db: Awaited<ReturnType<typeof openSqlite>>): Promise<void> {
  for (const table of ["sectors", "objects"]) {
    const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === "image")) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN image TEXT`);
    }
  }
}

async function main(): Promise<void> {
  const rng = mulberry32(0xc0ffee);

  const db = openSqlite(OUT_PATH);
  await db.exec(SCHEMA_SQL);
  await patchMissingImageColumns(db);
  const store = new WorldStore(db);
  const registry = new Registry(db, { leaseSeconds: 3600, cooldownSeconds: 0 });
  await ensureGenesis(store);
  const engine = new Engine({
    store,
    registry,
    prompts: loadPrompts(),
    images: openFsImages(null),
    codecs: loadCodecs(),
  });

  // Nothing else is holding a lease on the frontier at the same time, so
  // frontier_busy/claim_in_progress genuinely cannot happen here — a fresh
  // agent, one claim, one immediate submission, every time. No retry loop
  // needed.
  let built = await engine.store.count(); // genesis is already seeded
  let index = built;

  while (built < TARGET_SECTORS) {
    const { agent } = await engine.register(`mockup-agent-${index}`);
    const claim = await engine.claim(agent);

    const [x, y] = [claim.coordinate.x, claim.coordinate.y];
    const sectorPayload = makeSector(rng, [x, y], index);
    const { baked, errors } = await engine.submitSector(agent, claim, sectorPayload);
    if (!baked) {
      throw new Error(`unexpected validation failure at ${x},${y}: ${JSON.stringify(errors)}`);
    }
    built++;
    index++;
  }

  db.close();
  console.log(`wrote ${built} sectors to ${OUT_PATH}`);
}

main();
