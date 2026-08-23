#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 5 ]]; then
    echo "Usage: vision.sh <target> <domain> <manifest.md> <telemetry.json> <id>" >&2
    exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/../../lib/portable-vision.mjs" "$@"
