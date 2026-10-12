#!/bin/sh
# Publishes data/days.json + data/state.json to the repo's `data` branch as a single force-pushed commit
# (the same thing the board workflow does). Use it for the first publish and after a local FULL rebuild:
# a full crawl is thousands of requests, which Cloudflare blocks from GitHub's servers but not from home.
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
TMP=$(mktemp -d)
cp data/days.json data/state.json "$TMP/"
cd "$TMP"
git init -q -b data
# Vercel reads vercel.json from the branch it is about to deploy; this one tells it not to deploy data pushes
echo '{"git":{"deploymentEnabled":false}}' > vercel.json
git add days.json state.json vercel.json
git -c user.name="xo-pulse-bot" -c user.email="actions@users.noreply.github.com" commit -q -m "data: board"
git push -f "$REMOTE" data
rm -rf "$TMP"
