#!/usr/bin/env bash
#
# Jarvis Workbench 一键打包脚本（macOS）
#
# 把 README「路径 C」+《docs/发布手册.md》的构建→冒烟→校验和全流程串成一条命令：
#   质量门禁 → 构建 api/web → 装配 sidecar → tauri build(.app) → codesign ad-hoc 签名/验签
#   → hdiutil(.dmg) → 产物冒烟（ATB_READY + REST 401 + dmg 完整性/挂载验签）→ SHA-256 校验和
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
#   - 无头会话下 `tauri build` 的 DMG 步骤可能失败（osascript），属预期；只要 .app 产出即视为成功。
#   - 未签名 .app 在 Apple Silicon 上双击必报「已损坏，无法打开」（arm64 强制至少 ad-hoc 签名），
#     故第 4.5 步对 .app 做 codesign ad-hoc 签名 + 验签硬门禁；tauri 若已出 .dmg 打包的是未签名
#     .app，一律作废删除，签名后由本脚本用 hdiutil 统一重出（每架构只生成一次，二次生成会挤爆
#     runner 磁盘报 No space left，也不复用 tauri dmg）。

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

# ---------------------------------------------------------------- 第 4.5 步：codesign ad-hoc 签名 + 验签硬门禁
# 无 Apple Developer 证书的降级方案：`--sign -` 即 ad-hoc 签名，满足 Apple Silicon「二进制至少
# ad-hoc 签名」的硬要求（否则双击必报「已损坏」）；--deep 覆盖 resources/sidecar 内嵌套二进制
# （node、Prisma query engine .dylib/.node 等）。付费证书公证是后续升级项，见手册 §2.4。
step "第 4.5 步 · codesign ad-hoc 签名 + 验签"
codesign --force --deep --sign - "$APP_PATH" \
  || fail "codesign ad-hoc 签名失败：${APP_PATH}"
codesign --verify --deep --strict "$APP_PATH" \
  || fail "ad-hoc 签名校验未过：${APP_PATH}"
ok ".app 已 ad-hoc 签名并通过验签"

# ---------------------------------------------------------------- 第 5 步：签名后统一重出 .dmg（tauri dmg 打包的是未签名 .app，一律作废）
if [ "$SKIP_DMG" -eq 1 ]; then
  step "第 5 步 · 生成 .dmg（--skip-dmg 已跳过）"
else
  step "第 5 步 · 生成 .dmg（基于已签名 .app）"
  # tauri 若已产出 .dmg，其内容是签名前的 .app，必须删除后从已签名 .app 重出；
  # 每架构只生成一次（beta.1 二次生成曾把 arm64 runner 磁盘挤爆报 No space left）。
  rm -f "$BUNDLE_DIR"/dmg/*.dmg
  mkdir -p "$BUNDLE_DIR/dmg"
  hdiutil create -volname "Jarvis Workbench" \
    -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH" > /dev/null \
    || fail "hdiutil 生成 .dmg 失败"
  ok ".dmg 产出：${DMG_PATH}（签名后 hdiutil 重出）"
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
    # dmg 挂载点兜底卸载：上面任何 fail 退出都会先走这里，不泄漏挂载（未挂载时静默跳过）
    hdiutil detach "$TMPD/dmg-mnt" -force >/dev/null 2>&1 || true
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

  codesign --verify "$APP_PATH" || fail "签名复核未过：${APP_PATH}"
  ok ".app 签名复核通过（codesign --verify）"

  # dmg 本体验收：上面复核的是构建目录里的 .app，这里验最终镜像里那份——
  # 防 dmg 装配环节丢签/装错旧包（beta.2 零签名出货的残留盲区）。--skip-dmg 整体跳过。
  if [ "$SKIP_DMG" -eq 1 ]; then
    warn "--skip-dmg：跳过 dmg 完整性校验与挂载验签"
  else
    hdiutil verify "$DMG_PATH" >/dev/null 2>&1 \
      || fail "dmg 镜像完整性校验未过：${DMG_PATH}"
    ok "dmg 镜像完整性校验通过（hdiutil verify）"

    mkdir -p "$TMPD/dmg-mnt"
    hdiutil attach "$DMG_PATH" -nobrowse -mountpoint "$TMPD/dmg-mnt" >/dev/null \
      || fail "dmg 挂载失败：${DMG_PATH}"
    # detach 两条路径都覆盖：此处显式卸载 + cleanup_smoke（EXIT trap）里 -force 兜底，
    # 无论 codesign 验签成功还是 fail 退出都不泄漏挂载点。
    codesign --verify --deep --strict "$TMPD/dmg-mnt/Jarvis Workbench.app" \
      || fail "dmg 镜像内 .app 验签未过（装配环节丢签或装错旧包）：${DMG_PATH}"
    hdiutil detach "$TMPD/dmg-mnt" >/dev/null \
      || fail "dmg 挂载点卸载失败：$TMPD/dmg-mnt"
    ok "dmg 镜像内 .app 验签通过（挂载 codesign --verify --deep --strict）"
  fi
  warn "冒烟通过。三个历史缺陷（缺依赖、水位撞表、未签名「已损坏」）都靠这一步抓出来——发布前请勿 --skip-smoke"
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
