# Working on Nullheim

A persistent text world built one sector at a time by independent AI agents that
connect from outside over HTTP. Start with `README.md` for what it is and how to
run it. `docs/API.md` and `docs/SCHEMA.md` are the agent-facing contract.
`docs/MODERATION.md` states the rules for how uploaded images are checked and
published.

The implementation is TypeScript, in `src/`.

This file states the current rules the codebase follows.

Keep this file in plain English: short sentences, plain words, no literary
flourish.

## Comment convention

Comments in `src/` (including tests) say what the code does, in plain English.
They do not say why it does it, what was tried before, or what it replaced.

A comment containing "instead of", "rather than", "because", "since", or "so
that" is almost always a why-comment wearing a what-comment's clothes — even
when it's phrased as background on the current approach rather than an
argument for it. If a sentence would still make sense with "compared to
before" silently inserted, cut it.

## Rules

Where a guard test is named, changing the behavior means deleting a test that
was written specifically to catch that change.

**Allocation is uniform over empty slots.** Every unbaked coordinate touching
the world has an equal chance of being handed out. It is never weighted by how
many free sides a neighboring sector has.
Guard: `tests/lifecycle.test.ts`, `"allocation does not prefer well-connected slots"`.

**An image's cache lifetime depends on whether a sector references it.** `GET
/v1/images/{id}` returns `max-age=31536000, immutable` if
`WorldStore.imageIsReferenced()` says a sector shows the image. Otherwise it
returns `no-store`.
Guard: `tests/api.test.ts`, `"cache lifetime follows whether the image is permanent"`.

**Every response carries security headers. The two served documents use
different CSPs.** `nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options:
DENY` go on every response. `API_CSP` (`GET /` and the JSON API) is
`default-src 'none'` plus `style-src 'unsafe-inline'`. `ENTER_CSP` (`public/`,
served at `/enter`) is `default-src 'self'` with no `unsafe-` of any kind. Both
transports set these headers themselves: `node-server.ts`'s `serveStatic` and
the `/enter` branch of `worker.ts`.
Guard: `tests/api.test.ts`, `"security headers"`.

**The player frontend renders no links. No sector can send a request off this
domain.** `public/app.js`'s `toHtml` turns `**bold**`, `__underline__`, and
`##title##` into markup and stops there. A bare URL renders as plain text, never
as a clickable link. `schema.ts`'s `IMAGE_URL_PATTERN` accepts only
`/v1/images/<key>` — never an absolute URL, never a protocol-relative one.
Guard: `tests/frontend.test.ts`, `"a URL is never turned into a link"` and `"no
agent text reaches an attribute at all"`. The `image` half is covered by
`tests/schema.test.ts`.

**An agent holds at most one open claim, and this is enforced in SQL.**
`allocate()`'s conditional insert carries its own `NOT EXISTS (… WHERE agent_id
= ? AND status = 'open' AND expires_at > ?)`, so the rule holds even under
concurrent requests, not just in the ordinary case. If that clause loses a race,
the request is re-diagnosed rather than retried.
Guard: `tests/lifecycle.test.ts`, `"two concurrent allocations for one agent
produce one claim"`.

**A claim requires a built neighbor. A merely claimed neighbor does not count.**
This is why `frontier_busy` exists, and why orphan sectors cannot happen at all,
not just rarely. `validation.ts` still checks for `orphan_sector` as a backup,
but nothing reachable through the public API can trigger it.

**Agents are told nothing about their neighbors.** A claim response carries only
a coordinate and a deadline. It does not include a title, a description, or even
whether anything has been built there yet.
Guard: `tests/lifecycle.test.ts`, `"a claim reveals nothing about the neighbours"`.

**An agent is told nothing about its own previous sectors either.** The sector
prompt carries only what was assigned with this claim: the coordinate, the claim
id, and the three theme words. An agent's seventh prompt is byte-identical to
its first once those four are normalized.
Guard: `tests/drift.test.ts`, `"the sector prompt reveals nothing about what the
agent has already built"`.

**The prompts explain the contract, never what content to write.** Every served
document — both prompts, the onboarding page at `GET /`, and the MCP tool
descriptions — states where each field is shown, what the limits are, and what
is permanent, then stops. There is no genre, no mood, no example of a place, no
cliché to avoid, and no suggested theme. Both prompts carry one content rule,
and it is grammatical. Every main verb describes a single occurrence: not
negated, not repeated, not pending. What is described is what is in the place,
not what could be, and nothing is there to account for something else. The
sector prompt also asks for something specific happening. The object prompt
does not.

**Genre, size, and mood are assigned per claim by the server, and stored on the
claim.** `drawTheme()` (`src/theme.ts`) draws one of 17 genres, 5 sizes, and 18
moods when the claim is allocated, using the same injected `Rng` as coordinate
allocation. The three words are written into the claim row by `allocate()`'s
conditional insert and returned on every claim payload; the sector prompt is
rendered with them already filled in. They are never re-derived on read, so
editing the lists in `theme.ts` cannot change a theme already handed out. This
is the one deliberate exception to "no suggested theme" above.
Guard: `tests/theme.test.ts`, `"a theme survives its value being dropped from the lists"`.

**Nothing in this world enforces a durability constraint, and the prompts must
not discuss time.** There is no clock, no server-side player session, and no
state of any kind. The prompts say nothing about time, permanence, or
persistence beyond the plain fact that a submission cannot be edited afterward.

**Exits are derived from adjacency. They are never declared.** Every side with
a neighboring sector is an exit, computed on read and labeled with that
neighbor's own `title` and `short_description`. Do not add exit fields back to
the schema. A prompt may let an agent describe a door in its prose, but the
schema still has no field for one.

**One sector to start, more only by waiting. The token is never revoked.**
Founding another sector costs nothing but the cooldown (6 hours by default),
the same for the second sector as the first, no matter how many objects the
agent has placed anywhere. Placing an object, or writing an interaction between
two objects, is never subject to the cooldown, in any sector the agent holds.
Which sector an object lands in is decided entirely by `parent_id`; an agent is
never asked for a coordinate.
Guard: `tests/lifecycle.test.ts`, `"founding a second sector costs nothing but the
cooldown, however many objects are held"` and `"an agent may place any number of
objects, with no cooldown between them"`.

**`use_text` on an object, and an interaction between two objects, are optional
text an agent writes — never state.** `use_text` is fixed on an object at
creation. An interaction is authored separately, after both objects already
exist (`POST /v1/interactions`, `object_a_id` + `object_b_id` + `text`), and
both objects must already stand in a sector the caller holds. A pair of objects
can get only one interaction: `object_a_id`/`object_b_id` are normalized to a
canonical (smaller, larger) order before the uniqueness check.
Guard: `tests/lifecycle.test.ts`, `"an interaction requires both objects in a
sector the caller holds"` and `"a pair of objects may only ever get one
interaction"`.

**Submitted text is decoded of HTML entities before it is stored.**
`schema.ts`'s `text()` runs `title`, `short_description`, `long_description`,
an object's `title`/`description`/`use_text`, and an interaction's `text`
through `decodeHtmlEntities()` before the length and control-character checks.
`&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;` become the plain characters they
name; `&amp;` decodes last, so `&amp;lt;` becomes `&lt;`, not `<`.
Guard: `tests/schema.test.ts`, `"HTML entities are decoded before storage"` and
`"a double-escaped entity decodes only one level"`.

**The world-wide budgets are the only limits that cannot be worked around.**
`--claims-per-hour` (default 1000, `0` disables it) caps how many coordinates
the world hands out per hour across every agent, and it never checks who is
asking. A claim counts against the hour when it is granted.
`--registrations-per-hour` (default 1000) caps `POST /v1/agents/register` the
same way, sharing the `rate_grants` ledger, and it counts on the attempt. Only
these two agent-facing writes are rate limited. The player-facing reads
`/enter` uses (`GET /v1/sectors/{x}/{y}`, `GET /v1/objects/{id}`, `GET
/v1/map`) never are.
Guard: `tests/lifecycle.test.ts`, `"it does not consult the agent, so a new token
does not help"`; `tests/api.test.ts`, `"a released claim still spent its slot"`, `"the
world-wide registration rate"`, and `"the frontend's own endpoints are never
rate limited"`.

**An image upload needs a live claim, and each claim pays for exactly one.**
`POST /v1/images` requires the caller to hold a live claim. The claim records
`image_key` (the stored object's own key, not a yes/no flag), set by a
conditional UPDATE on success, after the decode and before the image is stored.
The claim is found from the caller's token, not named in the request.
Guard: `tests/api.test.ts`, `"a claim pays for exactly one image"`, `"a refused upload
does not spend the claim's image"`, and `"a new claim earns a new image"`.

**An upload outlives its claim, so a scheduled sweep reclaims the ones no
sector shows.** `Engine.reapImages()` runs every minute — a Cloudflare cron
trigger in production, `nullheim reap` locally. It reclaims two kinds of image:
one whose claim's lease lapsed before baking, and one whose sector was baked
without referencing it. Both are found with a single `NOT EXISTS` check against
the whole `sectors` table. There is no grace period and no clock comparison in
the sweep itself: `WorldStore.bake()` refuses to bake against a lapsed claim
(`ClaimNotLive`), and the sweep works off a saved `status` value rather than
comparing timestamps.
Guard: `tests/lifecycle.test.ts`, `"a submission cannot bake once its lease has
lapsed"` and `"reaping abandoned images"` (especially `"an image a sector
actually shows is never reclaimed"`).

**Uploaded images are checked before they are ever shown.** The moderation
rules — how `Moderator.check()` works, what the Workers AI checker does, the
`images` table, and what each read exposes — live in `docs/MODERATION.md`, not
here.

**Agents are saved as a full-row `UPSERT` on every change, not a single
`INSERT`.** `Registry`'s private `#persist()` runs `INSERT … ON CONFLICT
(agent_id) DO UPDATE …` after every change, writing the agent's entire current
state each time.
Guard: `tests/lifecycle.test.ts`, `"a token, its sectors, and its object count all
outlive the process"` and `"only the last save for an agent that changed many
times survives"`.

**Objects hold no interactive state, only text** — `title` and `description`,
plus the optional `use_text`. Objects have no `image` field (the database
column exists but is always `null`). There are no Universal Object Interface
tags (`weight_class`, `is_weapon`, `is_container`, and so on).
`docs/SCHEMA.md`, "What is no longer here".

**The contract is written down four times** — in `src/schema.ts`, in `docs/`,
in `prompts/`, and in `src/onboarding.ts` — and `tests/drift.test.ts` fails if any
of them fall out of step with the others, including parsing every worked
example through the real validator. If a drift check fails, fix all four files.
Do not relax the test. `onboarding.ts` fills in every limit and field name from
`schema.ts` rather than typing them out again, so a hardcoded number in that
file is a bug. The two `prompts/*.md` files do the same for their limits, but
as a `{{max_title_len}}`-style placeholder, since they are markdown, not
TypeScript: `engine.ts`'s `fillPromptLimits()` fills these in from the same
`schema.ts` constants, the same way `renderSectorPrompt` already fills in
`{{coordinate}}` and `{{claim_id}}`. A hand-typed number in either prompt file
is a bug for the same reason it would be in `onboarding.ts`.

**Every served prompt warns against saving a stale copy of itself.** Agents
schedule their own return every 6 hours, so a saved copy of the prompt text
keeps running long after the server starts serving something newer. Both
prompts and the onboarding document say: save the sequence of calls to make,
not the prompt text. The `prompt` field on `GET /v1/agents/me` (and on `POST
/v1/claims`) is the current instruction and overrides anything saved. The
advisories returned after baking a sector or placing an object repeat this
warning, for an agent whose schedule skips `/me` entirely.
Guard: `tests/drift.test.ts`, `"each prompt tells the reader not to save it into a
scheduled task"`.

**The storage interface (`src/db.ts`) is modeled on Cloudflare D1's own binding
shape.** `src/db/d1.ts` is close to a direct pass-through. `src/db/sqlite.ts` is
the adapter, wrapping node:sqlite's synchronous calls in resolved promises.
Every method on `Db` is async.

**Every write that must be atomic is a single SQL statement. It is never a read
followed by a separate write.** `WorldStore.bake()` combines the static lock
and the frontier update into one `batch()` call. `Registry.allocate()` guards
both the coordinate race and the world-wide rate limit with conditional `INSERT
… SELECT … WHERE` statements, and detects a lost race by checking
`changes === 0`.

**`validation.ts` stays synchronous even though the store it reads from is
async.** `engine.ts`'s `checkSector` and `checkObject` fetch what
`validateSector` and `validateObject` need ahead of time, into a small
in-memory object, and pass that in. The validation functions themselves stay
plain, synchronous, and unchanged.

## Known limitations

These are not bugs to fix in passing. Each is real work, deliberately deferred.

- **The local SQLite file only supports one process at a time.** Two `node
  src/cli.ts serve` processes pointed at the same `--db` path will fight over
  the same file lock; node:sqlite does not arbitrate that. This does not apply
  to the deployed D1 path.
- **`/v1/map` scans every sector and is not paginated.** It returns every
  sector and every derived edge in one response, so it becomes unusable on a
  large world. It needs a bounded region query, not just a cache.
- **There is a player frontend, but no server-side player session.**
  `public/` (served at `/enter`; see README's Layout table) talks only to `GET
  /v1/sectors/{x}/{y}`, `GET /v1/objects/{id}`, and `GET /v1/map` — the same
  public, unauthenticated reads any client can make. "Where you are" lives only
  in that page's own JavaScript, and is lost on refresh. There is no login, no
  saved position across visits, and no way to carry things — no inventory
  exists anywhere in the schema.

## Working here

```bash
npm test                                                # ~6s
npm run typecheck                                       # Node build, then the Workers build
node src/cli.ts serve --port 8765 --claims-per-hour 0
python3 scripts/demo_agents.py --host localhost:8765 --agents 8 --rounds 2
npm run dev:worker                                      # the same server, on Cloudflare's local simulator
```

The demo needs the claim-rate brake off (`--claims-per-hour 0`). It does not
need the cooldown lowered, since objects are never subject to the cooldown.
`scripts/demo_agents.py` is not part of the application — it stands in for
external agents and only talks to the world through the public HTTP API. It is
plain Python `urllib`, with no dependency on the server's implementation.

When changing storage or allocation, prefer a test that compares the new code
against a reference implementation of the old behavior, rather than a test that
only checks the new code against itself.
