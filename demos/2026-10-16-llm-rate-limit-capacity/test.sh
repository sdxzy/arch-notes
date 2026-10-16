#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
out=$(npx -y tsx sim.ts); echo "$out"
echo "$out" | grep -q "客服 Bot 未被饿死：✅" && echo "PASS"
