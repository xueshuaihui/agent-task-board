#!/usr/bin/env bash
#
# Jarvis Workbench 一键打包脚本（macOS）
#
# 把 README「路径 C」+《docs/发布手册.md》的构建→冒烟→校验和全流程串成一条命令：
#   质量门禁 → 构建 api/web → 装配 sidecar → tauri build(.app) → hdiutil(.dmg)
#   → 产物冒烟（ATB_READY + REST 401）→ SHA-256 校验和
#
# 用法：
#   bash scripts/package-release.sh                 # 全流程（含门禁与冒烟）
#   bash scripts/package-release.sh --skip-gates    # 跳过 typecheck/test（赶时间自担风险）
#   bash scripts/package-release.sh --skip-dmg      # 只出 .app，不产 .dmg
#   bash scripts/package-release.sh --skip-smoke    # 跳过产物冒烟（发布前不建议）
#
# 版本号唯一来源：apps/desktop/src-tauri/tauri.conf.json 的 version。
# 前置（缺一即停，见 README 路径 C 第 0 步）：
#   - apps/desktop/src-tauri/resources/sidecar/node（与目标架构一致的 node 二进制，不入库）
#   - Rust 工具链（$HOME/.cargo/bin/cargo）
#   - 仓库已 npm install（脚本缺 node_modules 时会自动补装）
#
# 已知坑（脚本已内置处理，见发布手册 §5.2）：
#   - 无头会话下 `tauri build` 的 DMG 步骤可能失败（osascript），属预期；
#     只要 .app 产出即视为成功，.dmg tauri 已出则复用，未出才由本脚本用 hdiutil 兜底生成。

set -euo pipefail

# ---------------------------------------------------------------- 参数解析
SKIP_GATES=0; SKIP_DMG=0; SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --skip-gates) SKIP_GATES=1 ;;
    --skip-dmg)   SKIP_DMG=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：${arg}（--help 查看用法）" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- 定位仓库根
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TAURI_DIR="apps/desktop/src-tauri"
SIDECAR_RES="$TAURI_DIR/resources/sidecar"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/Jarvis Workbench.app"
SMOKE_PORT=17994

step()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[0;33m⚠\033[0m %s\n' "$*"; }
fail()  { printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

VERSION="$(node -p "require('./$TAURI_DIR/tauri.conf.json').version")"
# 架构后缀：sidecar node 与 Prisma 引擎都取自构建机当前架构（bundle-sidecar.mjs），
# 产物天然是构建机架构 → x86_64 机器出 _x64.dmg，Apple Silicon 出 _arm64.dmg
case "$(uname -m)" in
  arm64)          ARCH_SUFFIX="arm64" ;;
  x86_64|i386)    ARCH_SUFFIX="x64" ;;
  *) fail "未知构建机架构：$(uname -m)" ;;
esac
DMG_PATH="$BUNDLE_DIR/dmg/Jarvis Workbench_${VERSION}_${ARCH_SUFFIX}.dmg"

echo "Jarvis Workbench 打包 v${VERSION}"
echo "仓库：$REPO_ROOT"

# ---------------------------------------------------------------- 第 0 步：前置检查
step "第 0 步 · 前置检查"

# node 二进制不入库（.gitignore 覆盖）：全新 checkout（如 CI）自动用当前 node 装配；
# 本机跨架构打包仍可按 README 路径 C 第 0 步预先放入目标架构二进制（下方架构校验会把关）。
if [ ! -f "$SIDECAR_RES/node" ]; then
  warn "$SIDECAR_RES/node 不存在（全新 checkout？），自动用当前 node 装配：$(command -v node)"
  mkdir -p "$SIDECAR_RES"
  cp "$(command -v node)" "$SIDECAR_RES/node"
fi
[ -f "$SIDECAR_RES/node" ] || fail "node 自动装配失败：$SIDECAR_RES/node 仍不存在"
NODE_ARCH=""
NODE_ARCH="$(file "$SIDECAR_RES/node" | grep -oE 'x86_64|arm64' || true)"
NODE_ARCH="${NODE_ARCH:-}"
[ -n "$NODE_ARCH" ] || fail "无法识别 $SIDECAR_RES/node 架构（file 输出无 x86_64/arm64）"
case "$NODE_ARCH" in x86_64) NODE_TAG="x64" ;; *) NODE_TAG="$NODE_ARCH" ;; esac
[ "$NODE_TAG" = "$ARCH_SUFFIX" ] || warn "node 二进制架构（${NODE_TAG}）与构建机架构（${ARCH_SUFFIX}）不一致，产物可能无法在目标机运行"
ok "node 二进制在位（${NODE_ARCH}）"

[ -x "$HOME/.cargo/bin/cargo" ] || fail "缺少 Rust 工具链（$HOME/.cargo/bin/cargo），先 rustup 安装"
ok "cargo：$("$HOME/.cargo/bin/cargo" --version 2>/dev/null)"

if [ ! -d node_modules ]; then
  warn "node_modules 缺失，自动执行 npm install（约数分钟）"
  npm install
fi
ok "npm 依赖在位"

# ---------------------------------------------------------------- 第 1 步：质量门禁
if [ "$SKIP_GATES" -eq 1 ]; then
  step "第 1 步 · 质量门禁（--skip-gates 已跳过）"
else
  step "第 1 步 · 质量门禁（typecheck + test）"
  npm run typecheck  || fail "typecheck 未过，中止打包"
  npm run test       || fail "测试未过，中止打包"
  ok "门禁全绿"
fi

# ---------------------------------------------------------------- 第 2 步：构建 api + web
step "第 2 步 · 构建 api + web"
npm run build || fail "npm run build 失败"
ok "api（tsc）+ web（vite）构建完成"

# ---------------------------------------------------------------- 第 3 步：装配 sidecar
step "第 3 步 · 装配 sidecar 打包资源（~135M）"
npm run build:sidecar -w @atb/api || fail "build:sidecar 失败"
ok "resources/sidecar 装配完成"

# ---------------------------------------------------------------- 第 4 步：tauri build 打包 .app
step "第 4 步 · tauri build 打包 .app"
export PATH="$HOME/.cargo/bin:$PATH"
TAURI_EXIT=0
( cd "$TAURI_DIR" && npx tauri build ) || TAURI_EXIT=$?
# 注意：set -e 下用 `… || TAURI_EXIT=$?` 捕获退出码（`; VAR=$?` 会被 set -e 直接杀掉）；
# 只认 .app 是否产出，不认 tauri 的退出码（见发布手册 §5.2）。
if [ -d "$APP_PATH" ]; then
  [ "$TAURI_EXIT" -ne 0 ] && warn "tauri build 退出码 ${TAURI_EXIT}（DMG 步骤失败属预期，.app 已产出）"
  ok ".app 产出：$APP_PATH"
else
  fail "tauri build 后未找到 ${APP_PATH}（退出码 ${TAURI_EXIT}）"
fi

# ---------------------------------------------------------------- 第 5 步：生成 .dmg（tauri 已出则复用，未出才 hdiutil 兜底）
if [ "$SKIP_DMG" -eq 1 ]; then
  step "第 5 步 · 生成 .dmg（--skip-dmg 已跳过）"
else
  step "第 5 步 · 生成 .dmg"
  TAURI_DMG=""
  if [ -d "$BUNDLE_DIR/dmg" ]; then
    TAURI_DMG="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' -print -quit 2>/dev/null || true)"
  fi
  if [ -n "$TAURI_DMG" ]; then
    DMG_PATH="$TAURI_DMG"
    ok ".dmg 产出：${DMG_PATH}（复用 tauri 产物，跳过兜底 hdiutil）"
  else
    mkdir -p "$BUNDLE_DIR/dmg"
    rm -f "$DMG_PATH"
    hdiutil create -volname "Jarvis Workbench" \
      -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH" > /dev/null \
      || fail "hdiutil 生成 .dmg 失败"
    ok ".dmg 产出：${DMG_PATH}（hdiutil 兜底生成）"
  fi
fi

# ---------------------------------------------------------------- 第 6 步：产物冒烟
if [ "$SKIP_SMOKE" -eq 1 ]; then
  step "第 6 步 · 产物冒烟（--skip-smoke 已跳过）"
else
  step "第 6 步 · 产物冒烟（临时数据目录 + 独立端口 ${SMOKE_PORT}）"
  TMPD="$(mktemp -d)"
  SMOKE_LOG="$(mktemp)"
  SMOKE_PID=""
  cleanup_smoke() {
    [ -n "$SMOKE_PID" ] && kill "$SMOKE_PID" 2>/dev/null
    rm -rf "$TMPD" "$SMOKE_LOG"
  }
  trap cleanup_smoke EXIT

  (
    ATB_DATA_DIR="$TMPD" ATB_PORT="$SMOKE_PORT" \
    ATB_UI_TOKEN=abc123def456abc123def456abc123de \
      "$APP_PATH/Contents/Resources/sidecar/node" \
      "$APP_PATH/Contents/Resources/sidecar/main.js" > "$SMOKE_LOG" 2>&1 &
    echo $! > "$TMPD/pid"
  )
  SMOKE_PID="$(cat "$TMPD/pid" 2>/dev/null || true)"

  READY=0
  for _ in $(seq 1 60); do
    if grep -q ATB_READY "$SMOKE_LOG" 2>/dev/null; then READY=1; break; fi
    sleep 0.5
  done
  [ "$READY" -eq 1 ] || { cat "$SMOKE_LOG" >&2; fail "sidecar 30s 内未打印 ATB_READY（日志见上）"; }
  ok "ATB_READY：$(grep ATB_READY "$SMOKE_LOG" | head -1 | cut -c1-120)"

  HTTP_CODE="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SMOKE_PORT/api/v1/tasks")"
  [ "$HTTP_CODE" = "401" ] || fail "REST 未返回 401（实际 ${HTTP_CODE}），鉴权守卫异常"
  ok "REST /api/v1/tasks → 401（鉴权正常）"
  warn "冒烟通过。两个历史缺陷（缺依赖、水位撞表）都靠这一步抓出来——发布前请勿 --skip-smoke"
fi

# ---------------------------------------------------------------- 第 7 步：校验和与产物清单
step "第 7 步 · SHA-256 校验和"
SHA_FILE="$BUNDLE_DIR/SHA256SUMS.txt"
if [ "$SKIP_DMG" -eq 1 ]; then
  shasum -a 256 "$APP_PATH" > "$SHA_FILE"
else
  shasum -a 256 "$DMG_PATH" > "$SHA_FILE"
fi
cat "$SHA_FILE"
ok "校验和已写入 $SHA_FILE"

step "打包完成（v${VERSION}）"
echo "  .app : $APP_PATH"
[ "$SKIP_DMG" -eq 1 ] || echo "  .dmg : $DMG_PATH"
echo "  校验和: $SHA_FILE"
echo ""
echo "发布到 GitHub Releases：见 README「发布到 GitHub Releases 速查」或 docs/发布手册.md §4"
