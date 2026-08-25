#!/usr/bin/env bash
# Prove the differential harness can actually fail.
#
# A harness that has only ever passed is worth very little. This applies a
# succession of small, deliberate breakages to the TypeScript implementation and
# checks that the harness notices each one, reverting after every attempt.
#
# Any mutation reported as NOT CAUGHT is a real blind spot in the harness, not a
# licence to ignore it.

set -uo pipefail
cd "$(dirname "$0")/.."

if ! git diff --quiet -- src/; then
  echo "refusing to run: src/ has uncommitted changes that would be lost"
  exit 2
fi

caught=0
missed=0

try() {
  local name="$1" file="$2" from="$3" to="$4"

  if ! grep -qF -- "$from" "$file"; then
    echo "  SKIP  $name (anchor not found in $file)"
    return
  fi
  perl -0pi -e "s/\Q$from\E/$to/" "$file"

  if timeout 240 node scripts/differential.ts >/dev/null 2>&1; then
    echo "  MISS  $name — harness did NOT notice"
    missed=$((missed + 1))
  else
    echo "  ok    $name — caught"
    caught=$((caught + 1))
  fi
  git checkout -- "$file"
}

echo "sabotaging the TypeScript implementation, one change at a time:"
echo

try "a text limit is off by one"        src/schema.ts     "MAX_TITLE_LEN = 64"          "MAX_TITLE_LEN = 63"
try "exits come back in another order"  src/store.ts      "return found;"               "return found.reverse();"
try "a rejection message is reworded"   src/validation.ts "is already part of the world" "is already part of the cosmos"
# orphan_sector is deliberately unreachable through the API — allocation only
# ever hands out coordinates touching the world (see CLAUDE.md). It is asserted
# as defence in depth and covered by validation.test.ts, so the harness cannot
# and should not be expected to catch a change to it.
try "an error code is renamed"          src/validation.ts '"no_such_parent"'            '"missing_parent"'
try "lengths count UTF-16 units"        src/schema.ts     "return [...value].length;"   "return value.length;"
try "the object tree loses its order"   src/store.ts      "bucket.push(world_object);"  "bucket.unshift(world_object);"
try "a derived exit drops its label"    src/store.ts      "name: neighbour.sector.title," "name: \"\","
try "the frontier includes itself"      src/store.ts      "this.#frontier.delete(coords.key(coordinate));" ""
try "genesis text changes"              src/engine.ts     "The Nullpoint"               "The Null Point"
try "the cooldown status changes"       src/api.ts        "throw new ApiError(429"       "throw new ApiError(423"
try "the cooldown wait is reworded"     src/registry.ts   "left before your next"       "left until your next"
try "the cooldown loses its decimal"    src/registry.ts   "remaining.toFixed(1)"        "Math.round(remaining)"

echo
echo "caught $caught, missed $missed"
[ "$missed" -eq 0 ]
