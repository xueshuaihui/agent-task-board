#!/usr/bin/env bash
# ============================================================================
# release.sh — Agent Task Board 一键发布
#
# 固化 docs/发布手册.md（Release SOP）的完整流程，每阶段可跳过、可单独补跑。
# 用法：
#   ./scripts/release.sh v0.0.2                 # 全流程（门禁→构建→冒烟→校验和→git→gh）
#   ./scripts/release.sh v0.0.2 --skip-gates    # 跳过 typecheck+test（刚跑过时）
#   ./scripts/release.sh v0.0.2 --skip-build    # 复用现有 tauri 产物
#   ./scripts/release.sh v0.0.2 --skip-git      # 不 commit / tag / push
#   ./scripts/release.sh v0.0.2 --skip-publish  # 不创建 GitHub Release（无 GH_TOKEN 时）
#   ./scripts/release.sh v0.0.2 --publish-only  # 只补跑 gh release 两步（产物须已在）
#   ./scripts/release.sh v0.0.2 --dry-run       # 只打印将执行的命令，不改任何状态
#
# 依赖：Node≥20、cargo（~/.cargo/bin）、gh（~/.local/bin）、GH_TOKEN（仅 publish 阶段）。
# 版本口径（SOP §0）：tag 是发布批次标识；包内版本跟随 apps/desktop/src-tauri/tauri.conf.json，
# prerelease 不必改它；DMG 文件名用包内版本。
# ============================================================================
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TAG="${1:?用法: ./scripts/release.sh vX.Y.Z [选项]}"
shift || true
[ "${TAG:0:1}" = "v" ] || { echo "✗ tag 必须 vX.Y.Z 形式（如 v0.0.2）"; exit 1; }

SKIP_GATES=0; SKIP_BUILD=0; SKIP_GIT=0; SKIP_PUBLISH=0; PUBLISH_ONLY=0; DRY_RUN=0
COMMIT_MSG="${ATB_RELEASE_COMMIT_MSG:-}"
for a in "$@"; do
  case "$a" in
    --skip-gates)   SKIP_GATES=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --skip-git)     SKIP_GIT=1 ;;
    --skip-publish) SKIP_PUBLISH=1 ;;
    --publish-only) PUBLISH_ONLY=1; SKIP_GATES=1; SKIP_BUILD=1; SKIP_GIT=1 ;;
    --dry-run)      DRY_RUN=1 ;;
    *) echo "✗ 未知选项: $a"; exit 1 ;;
  esac
done

PKG_VERSION="$(node -e "console.log(require('./apps/desktop/src-tauri/tauri.conf.json').version)")"
APP_DIR="apps/desktop/src-tauri/target/release/bundle"
APP_PATH="$APP_DIR/macos/Agent Task Board.app"
DMG_PATH="$APP_DIR/dmg/Agent Task Board_${PKG_VERSION}_x64.dmg"
SUMS="/tmp/SHA256SUMS-${TAG}.txt"
SMOKE_LOG=/tmp/atb-release-smoke.log

run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else echo "  \$ $*"; "$@"; fi; }
stage() { echo ""; echo "═══ $1 ═══"; }

# ---------------------------------------------------------------------------
stage "0/7 发布口径"
echo "  tag:        $TAG"
echo "  包内版本:   $PKG_VERSION (tauri.conf.json，prerelease 不改)"
echo "  DMG:        $DMG_PATH"
git fetch --tags --quiet 2>/dev/null || true
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "✗ tag $TAG 已存在，换号或先 git tag -d $TAG"; exit 1
fi

if [ "$PUBLISH_ONLY" = 0 ]; then

  # -------------------------------------------------------------------------
  if [ "$SKIP_GATES" = 0 ]; then
    stage "1/7 质量门禁（SOP §3.1，不许跳——除非 --skip-gates）"
    run npm run typecheck
    run npm run test
  fi

  # -------------------------------------------------------------------------
  if [ "$SKIP_BUILD" = 0 ]; then
    stage "2/7 构建 web+api（含 sidecar main.js 重建）"
    run npm run build
    # sidecar 资源不入库；源码有变必须重建，否则 .app 里跑的是旧接口（SOP §5.2）
    run npm run build:sidecar -w @atb/api

    stage "3/7 Tauri 打包 + DMG（hdiutil 兜底，SOP §5.2：无头下 bundle_dmg.sh 必失败）"
    # tauri CLI 不支持 --manifest-path，必须 cd 进 src-tauri（SOP §2 原文写法）。
    # bundle_dmg.sh 无头必失败（osascript）→ tauri 整体退非零，但 .app 已产出；
    # 只有 .app 都不存在才是真失败（SOP §5.2：用 hdiutil 兜底即可）。
    if [ "$DRY_RUN" = 1 ]; then
      echo "  [dry-run] cd apps/desktop/src-tauri && npx tauri build（bundle_dmg 失败可容忍）"
      echo "  [dry-run] hdiutil create ... $DMG_PATH"
    else
      if ! (cd apps/desktop/src-tauri && npx tauri build); then
        [ -d "$APP_PATH" ] || { echo "✗ tauri build 失败且 .app 未产出"; exit 1; }
        echo "  ⚠️ bundle_dmg.sh 失败（SOP §5.2 已知环境限制），.app 已产出，走 hdiutil 兜底"
      fi
      mkdir -p "$APP_DIR/dmg"
      echo "  \$ hdiutil create -volname 'Agent Task Board' -srcfolder '$APP_PATH' -ov -format UDZO '$DMG_PATH'"
      hdiutil create -volname "Agent Task Board" \
        -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH"
    fi
  fi

  # -------------------------------------------------------------------------
  stage "4/7 产物冒烟（SOP §3.2：临时目录模拟 .app 内真实启动）"
  if [ "$DRY_RUN" = 1 ]; then
    echo "  [dry-run] sidecar 启动 → 等 ATB_READY → curl /api/v1/tasks 期望 401 → 清理"
  else
    [ -x "$APP_PATH/Contents/Resources/sidecar/node" ] || { echo "✗ .app 内无 sidecar node，先跑构建"; exit 1; }
    TMPD="$(mktemp -d)"
    (ATB_DATA_DIR="$TMPD" ATB_PORT=17994 ATB_UI_TOKEN=abc123def456abc123def456abc123de \
      "$APP_PATH/Contents/Resources/sidecar/node" \
      "$APP_PATH/Contents/Resources/sidecar/main.js" > "$SMOKE_LOG" 2>&1 &)
    OK=0
    for _ in $(seq 1 60); do
      grep -q ATB_READY "$SMOKE_LOG" 2>/dev/null && { OK=1; break; }; sleep 0.5
    done
    if [ "$OK" = 0 ]; then pkill -f "Resources/sidecar/main.js" 2>/dev/null || true; echo "✗ 60s 内未见 ATB_READY，日志：$SMOKE_LOG"; rm -rf "$TMPD"; exit 1; fi
    grep ATB_READY "$SMOKE_LOG"
    # 先探测再清理——顺序不能反（上次把 pkill 放前面，服务器先死 curl 必 000）
    CODE="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:17994/api/v1/tasks || true)"
    pkill -f "Resources/sidecar/main.js" 2>/dev/null || true
    rm -rf "$TMPD"
    [ "$CODE" = "401" ] || { echo "✗ REST 期望 401（鉴权守卫），实际 $CODE"; exit 1; }
    echo "  ✓ ATB_READY + REST 401"
  fi

  # -------------------------------------------------------------------------
  stage "5/7 校验和（SOP §3.3：发布实跑为准，不沿用旧值）"
  run sh -c "cd '$APP_DIR' && shasum -a 256 'dmg/$(basename "$DMG_PATH")' | tee '$SUMS'"

  # -------------------------------------------------------------------------
  if [ "$SKIP_GIT" = 0 ]; then
    stage "6/7 提交 + annotated tag + 推送（SOP §4.1）"
    if [ -z "$COMMIT_MSG" ]; then
      COMMIT_MSG="release: $TAG UI 全面改版 + 审核通过免必填

- apps/web 表现层改版：双主题 token、Radix 行为层、motion 弹簧动效、sonner Toast；组件 API 向后兼容
- 审核流：APPROVE 三字段免必填（REJECT 保持必填），执行摘要结构化增强
- 新增一键发布脚本 scripts/release.sh（固化 Release SOP）"
    fi
    if [ "$DRY_RUN" = 1 ]; then
      echo "  [dry-run] git add -A && git commit -m <msg> && git push origin main"
      echo "  [dry-run] git tag -a $TAG && git push origin $TAG"
    else
      git add -A
      git commit -m "$COMMIT_MSG"
      run git push origin HEAD
      git tag -a "$TAG" -m "$TAG prerelease：UI 全面改版 + 审核通过免必填

- 主要变更：web 表现层全面改版（双主题/Radix/motion/sonner，组件 API 兼容）；审核 APPROVE 免必填与执行摘要增强
- 已知限制：未签名（Gatekeeper 首启拦截，见手册 2.4）；x86_64 单架构；A3 真机验收未完，正式版另发"
      run git push origin "$TAG"
    fi
  fi
fi

# ---------------------------------------------------------------------------
if [ "$SKIP_PUBLISH" = 0 ]; then
  stage "7/7 GitHub Release + 上传（SOP §4.2–4.4，需 GH_TOKEN）"
  [ -d "$APP_DIR/dmg" ] || { echo "✗ 无产物目录，先跑构建"; exit 1; }
  [ -f "$DMG_PATH" ] || { echo "✗ 缺 $DMG_PATH"; exit 1; }
  [ -n "${GH_TOKEN:-}" ] || { echo "✗ GH_TOKEN 为空。导出后重跑：GH_TOKEN=xxx ./scripts/release.sh $TAG --publish-only"; exit 1; }
  NOTES="/tmp/release-notes-${TAG}.md"
  cat > "$NOTES" <<EOF
# ${TAG} prerelease：UI 全面改版 + 审核通过免必填

## 安装
1. 下载 \`$(basename "$DMG_PATH" | tr ' ' '.')\`，校验：\`shasum -a 256 -c SHA256SUMS.txt\`
2. 挂载后拖入 Applications；**未签名**，首启右键→打开，或 \`xattr -cr "/Applications/Agent Task Board.app"\`

## 变更清单
- apps/web 表现层全面改版：浅/深双主题 token、渐变主按钮、毛玻璃顶栏、三态主题切换（light/dark/system）、弹簧微动效（reduced-motion 兜底）
- 组件库重建（20 个，Radix 行为层 + cva + sonner），对外 API 向后兼容
- 审核流：APPROVE 三字段免必填（REJECT 保持必填），执行摘要结构化增强
- 修复：tailwind-merge 自定义 token 词表缺失导致按钮/徽章文字色被误删

## 已知限制
- 未签名、x86_64 单架构（arm64 经 Rosetta）
- 包内版本仍为 ${PKG_VERSION}（tag 为批次标识，见发布手册 §0）
EOF
  run gh release create "$TAG" --title "$TAG prerelease：UI 全面改版 + 审核通过免必填" \
    --notes-file "$NOTES" --prerelease
  run gh release upload "$TAG" "$DMG_PATH" "$SUMS" --clobber
  gh release view "$TAG" --json name,tagName,isPrerelease,assets \
    --jq '.name + " | " + .tagName + " | prerelease=" + (.isPrerelease|tostring) + " | assets: " + ([.assets[].name]|join(", "))'
  echo ""
  echo "⚠️  GH_TOKEN 已出现在本会话环境——发布完成请立即 revoke/regenerate（SOP §5.1）"
  echo "📝 别忘了回填 docs/发版记录 v0.1.0.md（最终 sha + 修订记录）"
fi

echo ""
echo "✅ 发布流程结束（${TAG}）"
