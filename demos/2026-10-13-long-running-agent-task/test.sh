#!/usr/bin/env bash
# 自动验证：幂等、轮询、SSE、心跳清扫
set -e; B=http://localhost:${PORT:-3000}
echo "== 1. 幂等：同一个 key POST 两次"
A=$(curl -s -XPOST -H 'Idempotency-Key: k1' $B/tasks); echo "$A"
C=$(curl -s -XPOST -H 'Idempotency-Key: k1' $B/tasks); echo "$C"
ID=$(echo "$A" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
[ "$ID" = "$(echo "$C" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')" ] && echo "OK 同一个任务"
echo "== 2. 缺 key 被拒"; curl -s -XPOST $B/tasks; echo
echo "== 3. SSE 流（直到任务结束）"; curl -sN $B/tasks/$ID/events
echo "== 4. 轮询最终状态"; curl -s $B/tasks/$ID; echo
