# Moderation

This file states the current rules for how uploaded images are checked and
published. It follows the same convention as `CLAUDE.md`: it says what the
code does, not why. That explanation lives in `DECISIONS.md`, referenced by
name from each entry below. If you are changing a rule, read its
`DECISIONS.md` entry first, and add to that entry rather than deleting it.

**An upload is checked before it is ever shown, and there are only two
automated outcomes.** `Moderator.check()` (`src/moderation.ts`) returns `clean`
(published right away) or `unsure` (stored as `pending`, held for a human to
review). There is no automated rejection — every checked image spends the
claim's image slot no matter which outcome it gets. `rejected` exists only as a
state a human sets with `nullheim moderate --reject`, which is also this
world's only way to take an image down, even one already published.
See `DECISIONS.md`, "An upload is checked before it is ever shown, and there are only two automated outcomes".

**`nullheim moderate` reaches a deployed world by shelling out to `wrangler`.
It never runs on a request path.** `src/db/d1-wrangler.ts` runs `wrangler d1
execute`; `src/images/r2-wrangler.ts` runs `wrangler r2 object delete`. Both
exist only for this CLI, and both authenticate through the operator's own
`wrangler login` session — no separate Cloudflare API token or account/
database ID is needed. `--env ENV` selects which `wrangler.toml` environment
to target, omitted for the top-level (production) database. `batch()` in
`d1-wrangler.ts` inlines its parameters as SQL literals and is not atomic.
That is acceptable for the one batch this CLI issues (`rejectImage`), but
would not be acceptable for `bake()`.
Guard: `tests/db/d1-wrangler.test.ts`, `tests/images/r2-wrangler.test.ts`.
See `DECISIONS.md`, "`nullheim moderate` is remote-only".

**`--list` shows only images awaiting review (state `pending`), each with a
Cloudflare dashboard link to view it.** The link points at the R2 object's own
details page (`https://dash.cloudflare.com/{account}/r2/default/buckets/{bucket}/objects/{key}/details`);
the account id is resolved by running `wrangler whoami --json`.

**The moderation checker is a general vision-language chat model, run through
Cloudflare Workers AI.** It is prompted with five concrete Yes/No questions
(nudity, vulgar language, hate symbols, self-harm, sexual content involving a
minor), not asked for a verdict directly. An image counts as clean only if
all five are answered No; silence never counts as No. A truncated, refused,
or empty reply must not be read as clean. The model's input image is capped
at `MAX_CLASSIFICATION_WIDTH` (384px), downscaled separately from the copy
that gets stored. The model needs a one-time per-account opt-in call before
use.
Guard: `tests/moderation/workers-ai.test.ts`.
See `DECISIONS.md`, "The moderation checker is a general vision-language chat model, run through Workers AI".

**An `unsure` verdict carries a reason, logged (not stored) at upload time.**
`ModerationResult.reason` (`src/moderation.ts`) names which question the
classifier answered Yes to, or that its reply couldn't be parsed; it is null
for `clean`. `Engine.uploadImage` logs it when the verdict is `unsure`. The
human reviewer queue (`nullheim moderate --list`) still works from the image
itself, not from this field.

**Local runs and tests use `permissiveModerator()`** (`src/moderation/permissive.ts`).
It can be set to always return a fixed verdict, so a test can exercise the
`pending` path without making a network call.

**Moderation state lives in its own `images` table, separate from `claims`.**
`claims.image_key` stays the reaper's own source of truth. A missing `images`
row is treated as published (`WorldStore.imageIsPublished`).
Guard: `tests/lifecycle.test.ts`, `"a pending image referenced by a baked sector is
never reaped"`.
See `DECISIONS.md`, "Moderation state lives in its own `images` table, separate from `claims`".

**Reaping an image also deletes its `images` row, not just the blob and the
claim's key.** `WorldStore.deleteImageRecords()` runs after `clearClaimImages()`
in `Engine.reapImages()`, for the same keys. Without it, a `pending` or
`rejected` image whose claim gets reaped leaves a permanently dangling row —
`nullheim moderate --list` would keep showing an image that no longer exists.
Guard: `tests/lifecycle.test.ts`, `"reaping a pending image also deletes its
now-dangling moderation record"`.
See `DECISIONS.md`, "An upload outlives its claim, so a scheduled sweep reclaims the ones no sector shows".

**Both reads that decide whether an image can be shown check moderation
state.** `GET /v1/images/{id}` returns 404 (never 403) for a `pending` or
`rejected` key. `sectorView` leaves out a sector's `image` field until the
image is published.
Guard: `tests/api.test.ts`, the `"image moderation"` describe block.
See `DECISIONS.md`, "Both reads that decide whether an image can be shown check moderation state".

**`POST /v1/images` tells the uploader the moderation state. `GET` still does
not.** The `201` response includes a `state` field (`"published"` or
`"pending"`), and, when pending, a note explaining that `GET` will return 404
until a human clears it. `GET /v1/images/{id}` still returns 404 either way for
an unauthenticated reader.
See `DECISIONS.md`, "`POST /v1/images` tells the uploader the moderation state, `GET` still does not".
