#!/bin/sh
# Consistent online backup of the (ciphertext-only) database.
set -e
DATA="${1:-/var/lib/capnslog}"
OUT="${2:-./capnslog-$(date +%Y%m%d).db}"
sqlite3 "$DATA/capnslog.db" ".backup '$OUT'"
echo "wrote $OUT"
