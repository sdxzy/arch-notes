#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -d node_modules/sql.js ] || npm install --silent --no-audit --no-fund
out=$(npx tsx demo.ts); echo "$out"
echo "$out" | grep -q "ALL PASS" && echo "PASS"
