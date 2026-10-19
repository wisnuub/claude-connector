#!/usr/bin/env bash
# Builds the downloads for a release tag and publishes them on GitHub:
#
#   claude-connector.zip  - the WordPress plugin. Sites' auto-updater looks for
#                           exactly this asset name, so never rename it.
#   site-maintenance.zip  - the Site Maintenance dashboard add-on (dashboard +
#                           mcp-server), with its node_modules so it runs
#                           without `npm install`.
#
# Usage:  scripts/release.sh v1.9.0
#
# A new release gets both zips, with notes taken from the README changelog
# entry for that version. For a release that already exists only the add-on is
# (re)uploaded - the plugin zip sites download is left alone. ADDON_REF builds
# the add-on from another ref (default: the tag).
set -euo pipefail

TAG=${1:?usage: scripts/release.sh vX.Y.Z}
REPO=${REPO:-wisnuub/claude-connector}
ADDON_REF=${ADDON_REF:-$TAG}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
cd "$ROOT"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "No tag $TAG - create and push it first." >&2; exit 1; }

# The plugin.
git archive --format=zip --prefix=claude-connector/ -o "$OUT/claude-connector.zip" "$TAG" \
  BUILDING.md DESIGN-STYLES.md DIVI5.md KNOWLEDGE.md README.md claude-connector.php mcp-server tools worker.js
unzip -p "$OUT/claude-connector.zip" claude-connector/claude-connector.php | php -l >/dev/null

# The add-on.
mkdir -p "$OUT/stage"
git archive --format=tar --prefix=site-maintenance/ "$ADDON_REF" dashboard mcp-server | tar -x -C "$OUT/stage"
(cd "$OUT/stage/site-maintenance/dashboard" && npm ci --omit=dev --silent --no-audit --no-fund)
(cd "$OUT/stage" && zip -qr -X "$OUT/site-maintenance.zip" site-maintenance)

ls -lh "$OUT"/*.zip | awk '{print $5, $NF}'

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$OUT/site-maintenance.zip" --repo "$REPO" --clobber
  echo "Uploaded site-maintenance.zip to the existing $TAG release."
else
  VER=${TAG#v}
  HEAD=$(grep -m1 "^### $VER " README.md || true)
  TITLE=${HEAD:+v${HEAD#\#\#\# }}
  awk -v h="$HEAD" '$0==h{on=1;next} on&&/^### [0-9]/{exit} on' README.md > "$OUT/notes.md"
  printf '\n**Upgrading:** WP Admin → Plugins → Update now (or auto-update).\n' >> "$OUT/notes.md"
  gh release create "$TAG" "$OUT/claude-connector.zip" "$OUT/site-maintenance.zip" --repo "$REPO" \
    --verify-tag --latest --title "${TITLE:-$TAG}" --notes-file "$OUT/notes.md"
fi
