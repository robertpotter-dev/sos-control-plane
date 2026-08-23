#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 1 ]]; then
    echo "Usage: pdf.sh <file.pdf>" >&2
    exit 1
fi
if ! command -v pdftotext >/dev/null 2>&1; then
    echo "pdftotext is required for PDF extraction. Install poppler-utils, or use sos ingest --frontier." >&2
    exit 1
fi
pdftotext -layout -enc UTF-8 "$1" -
