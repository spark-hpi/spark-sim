#!/usr/bin/env bash
# Build the practice simulator and pack it into a single zip the player teams can run offline.
# Output: spark-sim-practice.zip  (dist-practice/ + serve-practice.mjs + SELF-HOST.md)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "★ Building practice simulator …"
npm run build:practice

stage="$(mktemp -d)/spark-sim-practice"
mkdir -p "$stage"
cp -R dist-practice "$stage/dist-practice"
cp deploy/serve-practice.mjs "$stage/serve-practice.mjs"
cp deploy/SELF-HOST.md "$stage/README.md"

out="$PWD/spark-sim-practice.zip"
rm -f "$out"
( cd "$(dirname "$stage")" && zip -qr "$out" "spark-sim-practice" )
rm -rf "$(dirname "$stage")"

echo "✓ Wrote $out"
echo "  Teams: unzip, then  node serve-practice.mjs  ->  http://localhost:8099"
