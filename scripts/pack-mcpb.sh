#!/usr/bin/env bash
# Build a production-grade .mcpb bundle.
#
# Strategy: stage the bundle in a temp dir so the dev environment stays intact.
#   1. Compile TypeScript -> server/  (in source tree)
#   2. Copy bundle assets to a staging dir
#   3. npm install --omit=dev in the stage
#   4. mcpb pack the stage
#   5. Clean up the stage
#
# Run from the project root: bash scripts/pack-mcpb.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BUNDLE_PATH="dist/aws-partner-central.mcpb"

echo "==> Cleaning previous build artifacts..."
rm -rf server/*.js server/services server/tools server/schemas
mkdir -p dist
rm -f "$BUNDLE_PATH"

echo "==> Compiling TypeScript..."
npx tsc

echo "==> Staging bundle in a temp directory..."
STAGE="$(mktemp -d -t aws-partner-central-mcpb-XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

cp -R server "$STAGE/"
cp manifest.json "$STAGE/"
cp package.json "$STAGE/"
if [ -f package-lock.json ]; then
  cp package-lock.json "$STAGE/"
fi
if [ -f README.md ]; then
  cp README.md "$STAGE/"
fi
if [ -f LICENSE ]; then
  cp LICENSE "$STAGE/"
fi
if [ -f icon.png ]; then
  cp icon.png "$STAGE/"
fi

echo "==> Installing production dependencies in stage..."
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent)

echo "==> Security audit of bundled (production) dependencies..."
# Gate the build on high/critical CVEs in shipped deps. Override only with
# SKIP_AUDIT=1 if you have triaged the finding.
if [ "${SKIP_AUDIT:-0}" != "1" ]; then
  (cd "$STAGE" && npm audit --omit=dev --audit-level=high) || {
    echo "ERROR: npm audit found high/critical vulnerabilities in production deps." >&2
    echo "       Triage and update deps, or re-run with SKIP_AUDIT=1 to override." >&2
    exit 1
  }
fi

echo "==> Pruning non-runtime files from bundled dependencies..."
# Shrinks the bundle: TypeScript sources, sourcemaps, changelogs, and test
# fixtures are never needed at runtime.
find "$STAGE/node_modules" -type f \
  \( -name "*.ts" -o -name "*.map" -o -name "*.md" -o -name "*.markdown" \) \
  -delete 2>/dev/null || true
find "$STAGE/node_modules" -type d \
  \( -name "test" -o -name "tests" -o -name ".github" \) \
  -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> Packing MCPB bundle..."
npx mcpb pack "$STAGE" "$BUNDLE_PATH"

echo ""
echo "==> Bundle ready: $BUNDLE_PATH"
ls -lh "$BUNDLE_PATH"
