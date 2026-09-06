# Moderation

This file states the current rules for how uploaded images are checked and
published. It follows the same convention as `CLAUDE.md`: it says what the
code does, not why.

**An upload is checked before it is ever shown, and there are only two
automated outcomes.** `Moderator.check()` (`src/moderation.ts`) returns `clean`
(published right away) or `unsure` (stored as `pending`, held for a human to
review). There is no automated rejection — every checked image spends the
claim's image slot no matter which outcome it gets. `rejected` exists only as a
state a human sets with `nullheim moderate --reject`, which is also this
world's only way to take an image down, even one already published.

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

**Reaping an image also deletes its `images` row, not just the blob and the
claim's key.** `WorldStore.deleteImageRecords()` runs after `clearClaimImages()`
in `Engine.reapImages()`, for the same keys. Without it, a `pending` or
`rejected` image whose claim gets reaped leaves a permanently dangling row —
`nullheim moderate --list` would keep showing an image that no longer exists.
Guard: `tests/lifecycle.test.ts`, `"reaping a pending image also deletes its
now-dangling moderation record"`.

**Both reads that decide whether an image can be shown check moderation
state.** `GET /v1/images/{id}` returns 404 (never 403) for a `pending` or
`rejected` key. `sectorView` leaves out a sector's `image` field until the
image is published.
Guard: `tests/api.test.ts`, the `"image moderation"` describe block.

**`POST /v1/images` tells the uploader the moderation state. `GET` still does
not.** The `201` response includes a `state` field (`"published"` or
`"pending"`), and, when pending, a note explaining that `GET` will return 404
until a human clears it. `GET /v1/images/{id}` still returns 404 either way for
an unauthenticated reader.

**Authored prose is checked on submission, and a refusal is a hard 403, not a
queue.** Sector and object titles and descriptions, and interaction text, are run
through a text chat model (`@cf/meta/llama-3.2-3b-instruct`) before a sector is
baked, an object is placed, or an interaction is written. The model is sent a
chat-messages form — a system turn demanding the strict `Question N: [Yes/No]`
reply format plus a user turn carrying the five questions and the prose — not a
flat prompt, which an instruct model answers by continuing the prose instead of
answering. The model is asked the
same Yes/No questions style as the image
checker, adapted to text; a flagged field, a missing answer, or an unparseable
reply refuses the submission with `403 content_banned` and the fixed message
"Your post contains terms or material that violate our guidelines.". There is
no `pending` state and no human queue for text: failing the check returns the
403 and the claim stays live, so the author can resubmit. A draft saved by a
non-finalising `POST /v1/claims/{id}/sector` is not moderated — only the real
bake is. Local runs and tests use `permissiveTextModerator()`
(`src/moderation/permissive-text.ts`), which passes text unless it contains the
marker word `banned`.
