#!/usr/bin/env bash
#
# Jarvis Workbench 一键打包脚本（Windows x64 · NSIS，Git Bash 下运行）
#
# scripts/package-release.sh（mac 版）的 Windows 对应版，全流程串成一条命令：
#   质量门禁 → 构建 api/web → 装配 sidecar → 打包资源硬校验（node.exe + windows 引擎）
#   → tauri build（NSIS .exe）→ 产物冒烟（ATB_READY + REST 401）→ SHA-256 校验和
# 步骤编号与 mac 版对齐；mac 的 4.2/4.5/5（plist 校验、codesign、hdiutil dmg）在
# Windows 无对应物，整体不存在，不是被跳过。
#
# 用法：
#   bash scripts/package-release-win.sh                 # 全流程（含门禁与冒烟）
#   bash scripts/package-release-win.sh --skip-gates    # 跳过 typecheck/test（CI 不建议）
#   bash scripts/package-release-win.sh --skip-smoke    # 跳过产物冒烟（Windows 包唯一的内容门禁，见第 6 步）
#   bash scripts/package-release-win.sh --help
#
# 版本号唯一来源：apps/desktop/src-tauri/tauri.conf.json 的 version。
# 产物：target/release/bundle/nsis/Jarvis Workbench_<version>_x64-setup.exe。
# 不签名是既定决策（无证书）：首启 SmartScreen 口径见 docs/发布手册.md §1.3。

set -euo pipefail

# ---------------------------------------------------------------- 参数解析
SKIP_GATES=0; SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --skip-gates) SKIP_GATES=1 ;;
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

step()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[0;33m⚠\033[0m %s\n' "$*"; }
fail()  { printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

VERSION="$(node -p "require('./$TAURI_DIR/tauri.conf.json').version")"
# NSIS 产物命名是 Tauri 2.11 口径：<productName>_<version>_x64-setup.exe；上传 GitHub 后
# 空格换成点号，与 dmg 同口径（手册 §1.3）。这里没有 mac 版 ARCH_SUFFIX 的选择余地：
# Windows 只出 x64 是既定决策，而 sidecar 的 node.exe 与 Prisma 引擎都取自构建机
# （bundle-sidecar.mjs），构建机架构==产物架构，由第 0 步的 uname -m 门禁把关。
EXE_PATH="$BUNDLE_DIR/nsis/Jarvis Workbench_${VERSION}_x64-setup.exe"

echo "Jarvis Workbench Windows 打包 v${VERSION}"
echo "仓库：$REPO_ROOT"

# ---------------------------------------------------------------- 第 0 步：前置检查
step "第 0 步 · 前置检查（Git Bash on windows-latest）"

# 架构判定与 mac 版 ARCH_SUFFIX 同源，但工具换成 uname -m：Git Bash 在 x64 runner 上报
# x86_64。若哪天 runner 换成 arm64，产物名里的 x64 就是谎话——当场停，别出包。
[ "$(uname -m)" = "x86_64" ] \
  || fail "Windows 包只支持 x64 构建机，当前架构 $(uname -m)（arm64 runner 出的包不叫 x64）"
ok "构建机架构 x86_64"

# windows-latest 预装 Rust 且已入 PATH；mac 版硬编码 $HOME/.cargo/bin/cargo，这里先认
# PATH、再回落到同一默认安装目录，两种情形都拿得到绝对路径供第 4 步加 PATH。
CARGO_BIN="$(command -v cargo || true)"
if [ -z "$CARGO_BIN" ] && [ -x "$HOME/.cargo/bin/cargo" ]; then
  CARGO_BIN="$HOME/.cargo/bin/cargo"
fi
[ -n "$CARGO_BIN" ] || fail "缺少 Rust 工具链（PATH 与 $HOME/.cargo/bin 都没有 cargo）"
ok "cargo：$("$CARGO_BIN" --version 2>/dev/null)"

[ -n "$(command -v node || true)" ] || fail "缺少 node（windows-latest 应预装；本机执行请先装 Node 22+）"
ok "node：$(node --version)"

# 冒烟显式用 curl.exe：Git Bash 的 curl 是 shell 函数（代理包装层），会改写参数；
# 它挡不住的路径问题由第 6 步的 -o NUL（Windows 版 /dev/null）绕开。
command -v curl.exe >/dev/null 2>&1 || fail "找不到 curl.exe（系统自带于 System32，缺失说明 PATH 异常）"

# 随包 node.exe 不入库（.gitignore 整目录覆盖 resources/sidecar/）：全新 checkout（CI）
# 先拷当前 node 占位，第 3 步 build:sidecar 再以 process.execPath 正式装配成 node.exe
# （bundle-sidecar.mjs win32 分支），两处都吃构建机 node——与 mac 版「自动装配」同理。
if [ ! -f "$SIDECAR_RES/node.exe" ]; then
  warn "$SIDECAR_RES/node.exe 不存在（全新 checkout？），先用当前 node 占位装配：$(command -v node)"
  mkdir -p "$SIDECAR_RES"
  cp "$(command -v node)" "$SIDECAR_RES/node.exe"
fi
[ -f "$SIDECAR_RES/node.exe" ] || fail "node.exe 自动装配失败：$SIDECAR_RES/node.exe 仍不存在"
ok "node.exe 在位"

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
  # 注意：这是测试第一次在 Windows 上跑，且它是硬门禁（同 mac 口径、不降级）。用例里任何
  # POSIX 假设（路径分隔符、chmod/0o600、/tmp 字面量、SIGTERM 语义）都会把**整条 Windows
  # 发布**拖红而不是只红一条用例——红了先修用例的平台假设，别用 --skip-gates 放行。
  npm run typecheck  || fail "typecheck 未过，中止打包"
  npm run test       || fail "测试未过，中止打包"
  ok "门禁全绿"
fi

# ---------------------------------------------------------------- 第 2 步：构建 api + web
step "第 2 步 · 构建 api + web"
npm run build || fail "npm run build 失败"
ok "api（tsc）+ web（vite）构建完成"

# ---------------------------------------------------------------- 第 3 步：装配 sidecar + Windows 硬校验
step "第 3 步 · 装配 sidecar 打包资源（~135M）"
npm run build:sidecar -w @atb/api || fail "build:sidecar 失败"

# Windows 版的「bundle 元数据硬校验」（mac 是第 4.2 步查 plist）：bundle-sidecar.mjs 已按
# process.platform 挑引擎、装错平台当场 die，但链路里任何一环被换旧/被缓存污染时，
# 「静默装了别平台引擎」的包只会在用户机上炸——这里以产物文件为准再钉一遍。
[ -f "$SIDECAR_RES/node.exe" ] \
  || fail "第 3 步跑完仍无 ${SIDECAR_RES}/node.exe（bundle-sidecar 若回退成无扩展名 node，win32 起不动）"
ENGINE_COUNT=0
for engine in "$SIDECAR_RES"/node_modules/.prisma/client/query_engine-windows*.dll.node; do
  [ -f "$engine" ] && ENGINE_COUNT=$((ENGINE_COUNT + 1))
done
[ "$ENGINE_COUNT" -gt 0 ] \
  || fail "sidecar 内没有 query_engine-windows*.dll.node（打包了别平台引擎，或 npm run prisma 未跑）。现场：$(ls "$SIDECAR_RES/node_modules/.prisma/client" 2>/dev/null | tr '\n' ' ')"
ok "sidecar 硬校验通过：node.exe + windows query engine ${ENGINE_COUNT} 枚"

# ---------------------------------------------------------------- 第 4 步：tauri build 打包 NSIS .exe
step "第 4 步 · tauri build 打包 NSIS .exe"
export PATH="$(dirname "$CARGO_BIN"):$PATH"
TAURI_EXIT=0
( cd "$TAURI_DIR" && npx tauri build ) || TAURI_EXIT=$?
# 与 mac 版同款「只认产物不认退出码」，但动机不同：mac 是 DMG 步骤在无头会话下会被
# osascript 拖挂（第 5 步另有 hdiutil 兜底）；Windows 这边退出码非 0 更多来自签名/收尾
# 噪音（本项目刻意不签名），安装包本体在就认——产物真不在，下面的 fail 会带目录现场。
if [ -f "$EXE_PATH" ]; then
  [ "$TAURI_EXIT" -ne 0 ] && warn "tauri build 退出码 ${TAURI_EXIT}（安装包已产出，按产物为准继续）"
  ok "NSIS 产出：$EXE_PATH"
else
  NSIS_LS="$(ls -la "$BUNDLE_DIR/nsis" 2>/dev/null | tail -n +2 || true)"
  fail "tauri build 后未找到 ${EXE_PATH}（退出码 ${TAURI_EXIT}）。bundle/nsis 现场：${NSIS_LS:-目录不存在}"
fi

# ---------------------------------------------------------------- 第 6 步：产物冒烟
if [ "$SKIP_SMOKE" -eq 1 ]; then
  step "第 6 步 · 产物冒烟（--skip-smoke 已跳过）"
else
  step "第 6 步 · 产物冒烟（临时数据目录 + 动态空闲端口）"
  # 这是 Windows job 最有价值的一步：直跑 resources/sidecar 里的 node.exe + main.js——
  # 与 NSIS 装进用户机的内容同一批文件（tauri.conf.json 的 bundle.resources 整目录照拷），
  # 引擎平台错、node.exe 起不动、迁移 deploy 不了，都在这里当场炸，而不是用户机上。
  # mac 版跑 .app 内的拷贝；Windows 无 .app 等价物（安装包不装没法跑），故吃 resources 目录。
  TMPD="$(mktemp -d)"
  SMOKE_LOG="$(mktemp)"
  SMOKE_PID=""
  SMOKE_WINPID=""
  cleanup_smoke() {
    # 收树用 taskkill（与 Rust 侧 stop 同理：node 可能带子进程，只杀直属会成孤儿、端口还被占）。
    # PID 用 ATB_READY 里 node 自报的 Windows pid——Git Bash 的 $! 是 MSYS pid，两套编号不通。
    # //PID 双斜杠是 MSYS 防路径改写写法：单斜杠 /PID 会被翻译成 C:/Program Files/Git/PID。
    [ -n "$SMOKE_WINPID" ] && taskkill //PID "$SMOKE_WINPID" //T //F >/dev/null 2>&1 || true
    [ -n "$SMOKE_PID" ] && kill "$SMOKE_PID" 2>/dev/null || true
    rm -rf "$TMPD" "$SMOKE_LOG"
  }
  trap cleanup_smoke EXIT

  # 不像 mac 固定 17994：共享 runner 上端口被占属常态，让 node 自己抓一个临时空闲端口
  # （close 后存在理论复用窗口，撞上即冒烟失败重跑，可接受）。
  # 取端口/取码都挂 || true：赋值失败会触发 set -e 静默退出、现场全丢，让下一行的
  # fail 用变量内容（空串 / 000）带出真实证据。
  SMOKE_PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));})' || true)"
  [ -n "$SMOKE_PORT" ] || fail "取不到空闲端口（node net 一行式无输出）"
  ok "冒烟端口：${SMOKE_PORT}"

  (
    # 环境口径对齐 Rust 侧拉起（sidecar.rs）：ATB_CONSOLE=1 让致命错误同时进 stderr，
    # 现场就在 ${SMOKE_LOG}；token ≥32 位与 mac 同一枚，仅为满足守卫的格式校验。
    ATB_DATA_DIR="$TMPD" ATB_PORT="$SMOKE_PORT" \
    ATB_UI_TOKEN=abc123def456abc123def456abc123de ATB_CONSOLE=1 \
      "$SIDECAR_RES/node.exe" "$SIDECAR_RES/main.js" > "$SMOKE_LOG" 2>&1 &
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
  SMOKE_WINPID="$(sed -n 's/.*ATB_READY.*"pid":\([0-9][0-9]*\).*/\1/p' "$SMOKE_LOG" | head -1)"
  [ -n "$SMOKE_WINPID" ] || warn "ATB_READY 行里没解析出 pid，收尾可能留孤儿进程（需手工 taskkill）"

  # 连不上时 curl.exe 退出码非 0 但 %{http_code} 已打出 000：|| true 把这 000 留给下一行的 fail 当证据
  HTTP_CODE="$(curl.exe -s --noproxy '*' -o NUL -w '%{http_code}' "http://127.0.0.1:${SMOKE_PORT}/api/v1/tasks" || true)"
  [ "$HTTP_CODE" = "401" ] || fail "REST 未返回 401（实际 ${HTTP_CODE}），鉴权守卫异常"
  ok "REST /api/v1/tasks → 401（鉴权正常）"

  warn "冒烟通过。Windows 包没有签名/公证门禁，这一步是「包内容真的可跑」的唯一闸口——发布前请勿 --skip-smoke"
fi

# ---------------------------------------------------------------- 第 7 步：校验和与产物清单
step "第 7 步 · SHA-256 校验和"
SHA_FILE="$BUNDLE_DIR/SHA256SUMS.txt"
# 用 sha256sum（Git Bash coreutils 自带）而非 mac 的 shasum：ubuntu 上的 release job 汇总
# 合并校验和也用 sha256sum，全链路输出口径一致（同算法、同 "<hash>  <file>" 行格式）。
sha256sum "$EXE_PATH" > "$SHA_FILE"
cat "$SHA_FILE"
ok "校验和已写入 $SHA_FILE"

step "打包完成（v${VERSION}）"
echo "  .exe : $EXE_PATH"
echo "  校验和: $SHA_FILE"
echo ""
echo "发布到 GitHub Releases：由 .github/workflows/release.yml 的 release job 汇总（口径见 docs/发布手册.md §1.3）"
