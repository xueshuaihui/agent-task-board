#!/usr/bin/env bash
# v0.0.4 #24：api 真启动冒烟门禁（QA#23 阻断的回归防线）。
#
# vitest 全绿 ≠ api 能启动：单测经 nest-di-shim 掩盖了真实 DI 解析
# （HEAD 曾有的实例：creation.service 用 `import type` 注入 SkillsService，
# emitDecoratorMetadata 把 design:paramtypes 编成 Function，真机 Nest 报
# "Nest can't resolve dependencies of the CreationService (…, ?)"）。
# 本脚本用**真实构建产物 + 真实 NestFactory** 起一次 sidecar，
# 打一个需要 DI 全链路解析的受保护 REST 端点拿 2xx 才算通过。
#
# 隔离性（硬性）：
# - ATB_DATA_DIR / ATB_LOGS_DIR 全部指向 mktemp -d，绝不碰 ~/.agent-board、
#   ~/.jarvis-workbench、~/Library/Logs；空数据目录让 bootstrap 走 fresh 建库
#   路径（applyMigrations 全量重放，非 prisma CLI），迁移逻辑对默认目录的搬迁
#   分支因 ATB_DATA_DIR ≠ defaultDataDir() 自动跳过（见 data-dir-migration.ts）。
# - ATB_UI_TOKEN 显式注入，绕开 dev-ui-token 落盘退化路径。
#
# 用法：bash scripts/boot-smoke.sh   （退出码 0=启动成功且端点 2xx）
set -uo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/atb-boot-smoke.XXXXXX")
LOG_FILE="${TMP_DIR}/boot.log"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

# 端口：随机高位 + lsof 探测，最多试 10 次找空闲口。
pick_port() {
  local p
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    p=$((18000 + RANDOM % 10000))
    if ! lsof -nP -iTCP:"${p}" -sTCP:LISTEN >/dev/null 2>&1; then echo "${p}"; return 0; fi
  done
  return 1
}
PORT=$(pick_port) || { echo "FAIL: 找不到空闲端口"; exit 1; }
TOKEN="boot-smoke-$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"

echo "== 构建（nest build，产物即真机入口）"
if ! npm run build --prefix "${API_DIR}" >/dev/null 2>"${TMP_DIR}/build.log"; then
  echo "FAIL: 构建失败"
  tail -20 "${TMP_DIR}/build.log"
  exit 1
fi

echo "== 启动（ATB_DATA_DIR=${TMP_DIR}，端口 ${PORT}，fresh 建库路径）"
ATB_DATA_DIR="${TMP_DIR}" \
ATB_LOGS_DIR="${TMP_DIR}/logs" \
ATB_MIGRATIONS_DIR="${API_DIR}/prisma/migrations" \
ATB_PORT="${PORT}" \
ATB_UI_TOKEN="${TOKEN}" \
  node "${API_DIR}/dist/main.js" >"${LOG_FILE}" 2>&1 &
API_PID=$!

on_exit_died() { # 进程已退出：直接判失败并给出启动日志尾部（DI 错误证据在这）
  echo "FAIL: sidecar 进程在就绪前退出"
  tail -30 "${LOG_FILE}"
  exit 1
}

# 轮询：最长 45s 等 ATB_READY / 端口可连。
BASE="http://127.0.0.1:${PORT}/api/v1"
READY=0
for _ in $(seq 1 90); do
  kill -0 "${API_PID}" 2>/dev/null || on_exit_died
  CODE=$(curl -s -o "${TMP_DIR}/resp.json" -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" "${BASE}/board" 2>/dev/null || true)
  case "${CODE}" in
    2??) READY=1; break ;;
  esac
  sleep 0.5
done

kill "${API_PID}" 2>/dev/null
wait "${API_PID}" 2>/dev/null

if [ "${READY}" != 1 ]; then
  echo "FAIL: 45s 内 GET /api/v1/board 未拿到 2xx（最后一次 HTTP 码：${CODE:-无}）"
  tail -30 "${LOG_FILE}"
  exit 1
fi

echo "  ok  GET /api/v1/board -> ${CODE}"
head -c 200 "${TMP_DIR}/resp.json"; echo
grep -q ATB_READY "${LOG_FILE}" && echo "  ok  ATB_READY 行存在" || echo "  warn 未见 ATB_READY（不影响门禁）"
echo "PASS: api 真启动冒烟通过（DI 全链路可解析）"
exit 0
