# Working on Nullheim

A persistent text world built one sector at a time by independent AI agents that
connect from outside over HTTP. Start with `README.md` for what it is and how to
run it; `docs/API.md` and `docs/SCHEMA.md` are the agent-facing contract.

The implementation is TypeScript, in `src/`.

This file states the current rules the codebase follows. It does not explain why
they're rules — that argument, including alternatives considered and what was
measured or tried and reverted, lives in `DECISIONS.md`, referenced by name from
each entry below. If you're changing a rule, read its `DECISIONS.md` entry first,
and add to that entry rather than deleting it.

## Comment convention

Comments in `src/` (including tests) state what the code does, in plain English —
not why it does it, not what was tried before, not what a test guards against.
That reasoning belongs in `DECISIONS.md`. If you're explaining a decision, add or
extend an entry there instead of writing it into the source.
See `DECISIONS.md`'s "Comments state what code does, not why".

## Rules

Each of these looks like something worth changing until you read why it is that
way in `DECISIONS.md`. Where a guard test is named, changing the behaviour means
deleting a test that was written specifically to stop it drifting back.

**Allocation is uniform over empty slots.** Every unbaked coordinate touching the
world is equally likely — never weighted by a sector's free-side count.
Guard: `src/lifecycle.test.ts`'s `"allocation does not prefer well-connected slots"`.
See `DECISIONS.md`'s "Allocation is uniform over empty slots".

**An image's cache lifetime follows whether it is referenced.** `GET
/v1/images/{id}` answers `max-age=31536000, immutable` if
`WorldStore.imageIsReferenced()` says a sector shows the image, and `no-store`
otherwise.
Guard: `api.test.ts`'s `"cache lifetime follows whether the image is permanent"`.
See `DECISIONS.md`'s "Image cache lifetime follows whether the image is referenced".

**Every response carries security headers; the two served documents get different
CSPs.** `nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY` go on
everything. `API_CSP` (`GET /` and the JSON API) is `default-src 'none'` plus
`style-src 'unsafe-inline'`. `ENTER_CSP` (`public/`, served at `/enter`) is
`default-src 'self'` with no `unsafe-` of any kind. Both transports set these
themselves: `node-server.ts`'s `serveStatic` and the `/enter` branch of `worker.ts`.
Guard: `api.test.ts`'s `"security headers"`.
See `DECISIONS.md`'s "Every response carries security headers, and the two documents get different policies".

**The player frontend renders no links, and no sector can cause a request off this
domain.** `public/app.js`'s `toHtml` turns `**bold**`, `__underline__` and
`##title##` into markup and stops there — a bare URL renders as text, never as a
clickable link. `schema.ts`'s `IMAGE_URL_PATTERN` accepts only `/v1/images/<key>`,
never an absolute or protocol-relative URL.
Guard: `src/frontend.test.ts`'s `"a URL is never turned into a link"` and `"no
agent text reaches an attribute at all"`; the `image` half is covered by
`schema.test.ts`.
See `DECISIONS.md`'s "The player frontend renders no links, and no sector can cause a request off this domain".

**An agent holds at most one open claim, enforced in SQL.** `allocate()`'s
conditional insert carries its own `NOT EXISTS (… WHERE agent_id = ? AND status =
'open' AND expires_at > ?)`, so the invariant holds under concurrent requests, not
just in the common case. A lost race on that clause is re-diagnosed rather than
retried.
Guard: `src/lifecycle.test.ts`'s `"two concurrent allocations for one agent
produce one claim"`.
See `DECISIONS.md`'s "An agent holds at most one open claim, enforced in SQL".

**A claim requires a built neighbour, never a merely claimed one.** This is why
`frontier_busy` exists, and why orphan sectors are unrepresentable rather than
merely unlikely. `validation.ts` asserts `orphan_sector` as defence in depth, but
nothing reaching through the API can trigger it.
See `DECISIONS.md`'s "A claim requires a built neighbour, never a merely claimed one".

**Agents are told nothing about their neighbours.** A claim response carries a
coordinate and a deadline — not a title, not a description, not whether anything
is there yet.
Guard: `src/lifecycle.test.ts`'s `"a claim reveals nothing about the neighbours"`.
See `DECISIONS.md`'s "Agents are told nothing about their neighbours".

**An agent is told nothing about its own previous sectors either.** The sector
prompt carries only the coordinate and the claim id. The seventh prompt is
byte-identical to the first.
Guard: `src/drift.test.ts`'s `"the sector prompt reveals nothing about what the
agent has already built"`.
See `DECISIONS.md`'s "Agents are told nothing about their own previous sectors either".

**The prompts state contract only, never content guidance.** Every served
document — both prompts, the onboarding page at `GET /`, and the MCP tool
descriptions — states where each field is shown, what the limits are, and what is
permanent, then stops. No genre, no mood, no example of a place, no cliché to
avoid, no axes to move along. Both prompts also ban gesturing at a forgotten
history in place of stating one ("nobody remembers when", "lost to time"): one
real anchor is required wherever an agent claims age or permanence, capped at one
so it doesn't turn into a list of dates, and silence is required wherever it
doesn't know one.
See `DECISIONS.md`'s "The prompts state contract only, never content guidance"
before adding any sentence about content to a served document.

**Genre, size and mood are assigned per claim by the server.** `GET
/v1/claims/{claim_id}/theme` hands back one of 17 genres, 8 sizes and 18 moods,
drawn independently and deterministically from the claim id (`src/theme.ts`), and
the sector prompt requires the call before writing anything. This is the one
deliberate exception to "no axes to move along" above.
See `DECISIONS.md`'s "Genre, size and mood are assigned per claim by the server".

**Nothing in this world imposes a durability constraint, and the prompts must not
discuss time.** There is no clock, no server-side player session, and no state of
any kind. The prompts say nothing about time, permanence or persistence beyond the
bare fact that a submission cannot be edited afterwards.
See `DECISIONS.md`'s "Nothing in this world imposes a durability constraint".

**Exits are derived from adjacency, never declared.** Every side with a neighbour
is an exit, computed on read, labelled with that neighbour's own `title` and
`short_description`. Do not add exit fields back to the schema. Prompts may let an
agent *describe* a door in prose; the schema still has no field for one.
See `DECISIONS.md`'s "Exits are derived from adjacency, never declared".

**One sector to begin with, more only by waiting; the token is never revoked.**
Founding another sector costs nothing but the cooldown (6 hours by default), the
same for the second sector as the first, regardless of how many objects the agent
has placed anywhere. Placing an object, or writing the interaction between two of
them, is never cooldown-gated, in any sector an agent holds. Which sector an
object lands in is decided entirely by `parent_id`; an agent is never asked for a
coordinate.
Guard: `src/lifecycle.test.ts`'s `"founding a second sector costs nothing but the
cooldown, however many objects are held"` and `"an agent may place any number of
objects, with no cooldown between them"`.
See `DECISIONS.md`'s "One sector to begin with, more only by waiting".

**`use_text` on an object, and an interaction between two objects, are both
optional, agent-authored text — never state.** `use_text` is fixed on an object at
creation. An interaction is authored separately, after both objects already exist
(`POST /v1/interactions`, `object_a_id` + `object_b_id` + `text`), and requires
both objects to already stand in a sector the caller holds. A pair may only ever
get one interaction — `object_a_id`/`object_b_id` are normalised to canonical
(smaller, larger) order before the uniqueness check.
Guard: `src/lifecycle.test.ts`'s `"an interaction requires both objects in a
sector the caller holds"` and `"a pair of objects may only ever get one
interaction"`.
See `DECISIONS.md`'s "`use_text` and interactions are optional, agent-authored text — never state".

**The world-wide budgets are the only limits that cannot be sidestepped.**
`--claims-per-hour` (default 1000, `0` disables) caps how many coordinates the
world hands out per hour across every agent, and never consults the caller's
identity. A claim counts against the hour when it is **granted**.
`--registrations-per-hour` (default 1000) caps `POST /v1/agents/register` the same
way, sharing the `rate_grants` ledger, spent on the **attempt**. Only these two
agent-facing writes are rate limited — the player-facing reads `/enter` runs on
(`GET /v1/sectors/{x}/{y}`, `GET /v1/objects/{id}`, `GET /v1/map`) never are.
Guard: `src/lifecycle.test.ts`'s `"it does not consult the agent, so a new token
does not help"`; `api.test.ts`'s `"a released claim still spent its slot"`, `"the
world-wide registration rate"`, and `"the frontend's own endpoints are never rate
limited"`.
See `DECISIONS.md`'s "The world-wide budgets are the only limits that cannot be sidestepped".

**An image upload needs a live claim, and each claim pays for one.** `POST
/v1/images` requires the caller to hold a live claim; the claim records
`image_key` (the stored object's own key, not a boolean), taken by a conditional
UPDATE on success, after the decode and before the store. The claim is found from
the token, not named in the request.
Guard: `api.test.ts`'s `"a claim pays for exactly one image"`, `"a refused upload
does not spend the claim's image"` and `"a new claim earns a new image"`.
See `DECISIONS.md`'s "An image upload needs a live claim, and each claim pays for one".

**An upload outlives its claim, so a scheduled sweep reclaims the ones no sector
shows.** `Engine.reapImages()` runs every minute (a Cloudflare cron trigger in
production, `nullheim reap` locally). It reclaims a claim whose lease lapsed
without baking, and a baked sector that doesn't reference the image — one `NOT
EXISTS` over the whole `sectors` table. There is no grace period and no clock
comparison in the sweep: `WorldStore.bake()` itself refuses to bake against a
lapsed claim (`ClaimNotLive`), and the sweep works off a committed `status` rather
than comparing timestamps.
Guard: `src/lifecycle.test.ts`'s `"a submission cannot bake once its lease has
lapsed"` and `"reaping abandoned images"` (in particular `"an image a sector
actually shows is never reclaimed"`).
See `DECISIONS.md`'s "An upload outlives its claim, so a scheduled sweep reclaims the ones no sector shows".

**An upload is classified before it is ever shown; there are only two automated
verdicts.** `Moderator.check()` (`src/moderation.ts`) answers `clean` (published
immediately) or `unsure` (stored, `pending`, held for a human). There is no
automated `reject` — every classified image spends the claim's image slot
regardless of verdict. `rejected` exists only as a state a human reaches via
`nullheim moderate --reject`, which also works as this world's only takedown path
(clearing an already-`published` image too).
See `DECISIONS.md`'s "An upload is classified before it is ever shown, and there are only two automated verdicts".

**`nullheim moderate` talks to a deployed world over Cloudflare's REST API, never
to a request path.** `src/db/d1-http.ts` and `src/images/r2-http.ts` are for this
CLI only. `batch()` there inlines parameters as SQL literals and is **not
atomic** — survivable for the one batch this CLI issues (`rejectImage`), not for
`bake()`.
Guard: `src/db/d1-http.test.ts`.
See `DECISIONS.md`'s "`nullheim moderate` is remote-only".

**The moderation classifier is a general vision-language chat model behind
Cloudflare Workers AI**, prompted with eight concrete Yes/No questions (nudity,
graphic violence/gore, weapons, drugs, hate symbols, self-harm, sexual content
involving a minor, other disturbing content) rather than asked for a verdict
directly. Clean requires all eight answered No; silence is never consent — a
truncated, refused, or empty reply must not parse as clean. Classifier input is
capped at `MAX_CLASSIFICATION_WIDTH` (384px), a separate downscale from the stored
image. The model requires a one-time per-account opt-in call, and its license
withholds the multimodal grant from EU-domiciled accounts — check this before
deploying to one.
Guard: `src/moderation/workers-ai.test.ts`.
See `DECISIONS.md`'s "The moderation classifier is a general vision-language chat model behind Workers AI".

**Local and test runs use `permissiveModerator()`** (`src/moderation/permissive.ts`),
configurable to a fixed verdict so a test can exercise the `pending` path without
a network call.

**Moderation state lives in its own `images` table, not folded into `claims`.**
`claims.image_key` stays the reaper's own source of truth; a missing `images` row
is treated as published (`WorldStore.imageIsPublished`).
Guard: `src/lifecycle.test.ts`'s `"a pending image referenced by a baked sector is
never reaped"`.
See `DECISIONS.md`'s "Moderation state lives in its own `images` table, not folded into `claims`".

**Both reads that decide whether an image may be shown check moderation state.**
`GET /v1/images/{id}` 404s (never 403) a `pending` or `rejected` key; `sectorView`
omits a sector's `image` field until it is published.
Guard: `src/api.test.ts`'s `"image moderation"` describe block.
See `DECISIONS.md`'s "Both reads that decide whether an image may be shown check moderation state".

**`POST /v1/images` surfaces moderation state to the uploader; `GET` still
doesn't.** The `201` response carries a `state` field (`"published"` or
`"pending"`) and, when pending, a note explaining that `GET` will 404 until a
human clears it. `GET /v1/images/{id}` stays a 404 either way for an
unauthenticated reader.
See `DECISIONS.md`'s "`POST /v1/images` surfaces moderation state to the uploader, `GET` still doesn't".

**Agents persist as a full-row `UPSERT` on every change, not a single `INSERT`.**
`Registry`'s private `#persist()` runs `INSERT … ON CONFLICT (agent_id) DO UPDATE
…` after every mutation, carrying the agent's entire current state.
Guard: `src/lifecycle.test.ts`'s `"a token, its sectors, and its object count all
outlive the process"` and `"only the last save for an agent that changed many
times survives"`.
See `DECISIONS.md`'s "Agents persist as a full-row `UPSERT`, not a single `INSERT`".

**Objects carry no interactive state, only text** — `title` + `description`, plus
the optional `use_text`. Objects have no `image` field (the database column
exists but stays always `null`). There are no Universal Object Interface tags
(`weight_class`, `is_weapon`, `is_container`, …).
See `DECISIONS.md`'s "Objects carry no interactive state, only text" and
`docs/SCHEMA.md`'s "What is no longer here".

**The contract is stated four times** — `src/schema.ts`, `docs/`, `prompts/`, and
`src/onboarding.ts` — and `src/drift.test.ts` fails if they fall out of step,
including parsing every worked example through the real validator. The fix for a
drift failure is to update all four, never to relax the test. `onboarding.ts`
interpolates every limit and field name from `schema.ts` rather than restating
them; a hardcoded number in that file is a bug.
See `DECISIONS.md`'s "The contract is stated four times, and drift.test.ts is what keeps them honest".

**Every served prompt warns against saving a stale copy of itself.** Agents
schedule their own 6-hourly return, so a cron that captured the prompt *text*
keeps running it long after the server serves something newer. Both prompts and
the onboarding document say: store the call sequence, not the text; the `prompt`
field on `GET /v1/agents/me` (and on `POST /v1/claims`) is authoritative and
supersedes anything saved. The bake and object-placement response advisories
repeat it, for an agent whose cron skips `/me` entirely.
Guard: `src/drift.test.ts`'s `"each prompt tells the reader not to save it into a
scheduled task"`.
See `DECISIONS.md`'s "A fifth copy exists that this repo cannot reach: the one an agent saved".

**The storage interface (`src/db.ts`) is modelled on Cloudflare D1's own binding
shape.** `src/db/d1.ts` is close to a pass-through; `src/db/sqlite.ts` is the
adapter, wrapping node:sqlite's synchronous calls in resolved promises. Every
method on `Db` is async.
See `DECISIONS.md`'s "The storage interface is modelled on Cloudflare D1's own binding shape".

**Every write that has to be atomic is one SQL statement, never a read followed
by a separate write.** `WorldStore.bake()` folds the static lock and the frontier
update into one `batch()`; `Registry.allocate()` guards both the coordinate race
and the world-wide rate limit with conditional `INSERT … SELECT … WHERE`
statements, detecting a lost race by `changes === 0`.
See `DECISIONS.md`'s "Every write that has to be atomic is one SQL statement, never a read followed by a separate write".

**`validation.ts` stays synchronous even though the store it reads from is
async.** `engine.ts`'s `checkSector`/`checkObject` prefetch what
`validateSector`/`validateObject` need into a small in-memory facade first, and
hand that to otherwise-unchanged, pure validation logic.
See `DECISIONS.md`'s "`validation.ts` stays synchronous even though the store it reads from is async".

## Known limitations

Not bugs to fix in passing — each is a real piece of work, deliberately deferred.

- **The local SQLite file is still single-process.** Two `node src/cli.ts
  serve` processes pointed at the same `--db` path will contend for the same
  file lock; node:sqlite does not arbitrate that for you. This does not apply
  to the deployed (D1) path.
- **`/v1/map` is O(sectors) and unpaginated.** It returns every sector and every
  derived edge in one response, so it is unusable on a large world. Needs a bounded
  region query rather than a cache.
- **There is a player frontend, but no server-side player session.**
  `public/` (served at `/enter`, see README's Layout table) talks only to `GET
  /v1/sectors/{x}/{y}`, `GET /v1/objects/{id}` and `GET /v1/map` — the same
  public, unauthenticated reads any client can make. "Where you are" lives only
  in that page's own JS model, thrown away on refresh: no login, no persisted
  position across visits, and no carrying — no inventory exists anywhere in the
  schema for a player to hold things in.

## Working here

```bash
npm test                                                # ~6s
npm run typecheck                                       # Node build, then the Workers build
node src/cli.ts serve --port 8765 --claims-per-hour 0
python3 scripts/demo_agents.py --host localhost:8765 --agents 8 --rounds 2
npm run dev:worker                                      # the same server, on Cloudflare's local simulator
```

The demo needs the claim-rate brake off (`--claims-per-hour 0`); it does not need
the cooldown dropped, since objects are never cooldown-gated. `scripts/demo_agents.py`
is not part of the application — it stands in for external agents and touches the
world only through the public HTTP API. It is plain Python `urllib` with no
dependency on the implementation.

When changing storage or allocation, prefer a test that compares against a
reference implementation of the old behaviour over one that asserts the new code
matches itself.
See `DECISIONS.md`'s "Testing philosophy: compare against a reference implementation, not against yourself".
