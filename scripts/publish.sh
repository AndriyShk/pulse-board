#!/bin/sh
# Publishes data/board.json, data/days.json + data/state.json to the repo's `data` branch as a single force-pushed commit
# (the same thing the board workflow does). Use it for the first publish and after a local FULL rebuild:
# a full crawl is thousands of requests, which Cloudflare blocks from GitHub's servers but not from home.
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
TMP=$(mktemp -d)
cp data/board.json data/days.json data/state.json "$TMP/"
cd "$TMP"
git init -q -b data
git add board.json days.json state.json
git -c user.name="xo-pulse-bot" -c user.email="actions@users.noreply.github.com" commit -q -m "data: board"
git push -f "$REMOTE" data
rm -rf "$TMP"
