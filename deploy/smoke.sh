#!/usr/bin/env bash
# deploy/smoke.sh — 部署冒烟（真跑）：隔离数据目录起服务 → 断言关键行为 → 必杀干净。
# 用法：bash deploy/smoke.sh            # 本机起 :3917
#       SMOKE_PORT=4000 SMOKE_BASE=http://somehost:4000 bash deploy/smoke.sh
#       SMOKE_BASE 指向容器/远程实例时不本机起进程，只打探针。
set -u
cd "$(dirname "$0")/.." || exit 9

PORT="${SMOKE_PORT:-3917}"
BASE="${SMOKE_BASE:-http://127.0.0.1:$PORT}"
EXPECTED_VERSION="$(node -p "require('./package.json').version")"
SRV=""
TMP="$(mktemp -d)"
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; [ -n "$SRV" ] && wait "$SRV" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

if [ -z "${SMOKE_BASE:-}" ]; then
  # 隔离数据：会话/笔记/收藏全部落到临时目录，不碰真实 data/
  NOTES_DATA_DIR="$TMP" SESSIONS_FILE="$TMP/sessions.json" BOOKMARK_DATA="$TMP/bookmarks.json" \
    PORT="$PORT" node server.js >"$TMP/server.log" 2>&1 &
  SRV=$!
fi

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$1"; }
fail() { echo "SMOKE FAIL: $1"; exit 1; }

# 等就绪（最多 10s）
for _ in $(seq 1 40); do
  [ "$(code "$BASE/health")" = "200" ] && break
  sleep 0.25
done

[ "$(code "$BASE/health")" = "200" ] || fail "/health 非 200"
curl -s --max-time 5 "$BASE/health" | grep -q "\"version\":\"$EXPECTED_VERSION\"" \
  || fail "health 版本 != package.json($EXPECTED_VERSION)"
[ "$(code "$BASE/%")" = "400" ] || fail "畸形编码 /% 应 400（一发崩进程回归）"
[ "$(code "$BASE/health")" = "200" ] || fail "畸形请求后进程未存活"
[ "$(code "$BASE/api/bookmarks")" = "401" ] || fail "收藏 API 未登录应 401（若 404=收藏路由未挂载）"
[ "$(code "$BASE/api/metrics")" = "401" ] || fail "/api/metrics 未登录应 401"
[ "$(code "$BASE/login.html")" = "200" ] || fail "登录页非 200"

echo "SMOKE PASS ($BASE): health=200 version=$EXPECTED_VERSION /%=400且存活 bookmarks=401 metrics=401 login=200"
