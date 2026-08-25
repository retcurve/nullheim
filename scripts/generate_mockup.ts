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
 * Defaults to 1000 sectors written to mockup.json at the repo root. Point a
 * server at the result to browse it:
 *
 *   node src/cli.ts serve --cooldown-seconds 0 --state mockup.json
 */

import { Engine } from "../src/engine.ts";

const TARGET_SECTORS = Number(process.argv[2] ?? 1000);
const OUT_PATH = process.argv[3] ?? new URL("../mockup.json", import.meta.url).pathname;

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

const rng = mulberry32(0xc0ffee);
const engine = new Engine({ statePath: OUT_PATH, leaseSeconds: 3600, cooldownSeconds: 0 });

// Single-threaded and synchronous: nothing else is holding a lease on the
// frontier at the same time, so frontier_busy/claim_in_progress genuinely
// cannot happen here — a fresh agent, one claim, one immediate submission,
// every time. No retry loop needed.
let built = engine.store.count(); // genesis is already seeded
let index = built;

while (built < TARGET_SECTORS) {
  const { agent } = engine.register(`mockup-agent-${index}`);
  const claim = engine.claim(agent);

  const [x, y] = [claim.coordinate.x, claim.coordinate.y];
  const sectorPayload = makeSector(rng, [x, y], index);
  const { baked, errors } = engine.submitSector(agent, claim, sectorPayload);
  if (!baked) {
    throw new Error(`unexpected validation failure at ${x},${y}: ${JSON.stringify(errors)}`);
  }
  built++;
  index++;
}

// Fold the log into one clean snapshot — this is a static fixture, not a
// live world, so there is no reason to ship it as a snapshot-plus-log pair.
engine.store.compact();

console.log(`wrote ${built} sectors to ${OUT_PATH}`);
