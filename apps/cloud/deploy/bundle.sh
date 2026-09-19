#!/usr/bin/env bash
#
# Agent Task Board 云端市场 · 本地打生产镜像包（上传服务器离线部署）
#
# 用法：
#   bash apps/cloud/deploy/bundle.sh            打成固定名产物（服务端不带版本号）
#   PLATFORM=linux/arm64 bash apps/cloud/deploy/bundle.sh
#
# 服务端没有「版本号」这个概念：镜像固定 tag latest、包名与运维目录固定（/opt/agent-task-board-cloud），
# 包一律上传到服务器 /opt/agent-task-board-cloud 并解压进去，发版命令逐字可复用。
# 要回答「线上跑的是哪一版」看包内 BUILD-INFO.txt、docker image inspect 的
# org.opencontainers.image.revision 标签、或 GET /healthz 的 commit 字段；回退靠 update 自动留的 :prev。
#
# 产物：dist/agent-task-board-cloud-prod.tar.gz
#   ├── images/agent-task-board-cloud-images.tar.gz   cloud + caddy 两个镜像（服务器不联网也能起）
#   ├── docker-compose.prod.yml                       生产编排（cloud + caddy）
#   ├── Caddyfile                                     Caddy 边缘配置（域名/TLS 由环境变量注入）
#   ├── deploy.sh                                     服务器运维入口（首次部署 / update / check / backup）
#   ├── .env.prod.example                             配置模板
#   └── BUILD-INFO.txt                                打包时的 commit / 时间 / 架构 / 工作区是否干净
#
# 说明：镜像在构建机现场编译，服务器只需要 Docker + 能 load 这个包，
#       不需要源码、不需要 Node、不需要访问任何镜像站。对外 HTTPS 由包内 caddy 自动签发。
# 写法约束：$VAR 紧跟中文时必须写 ${VAR}——macOS 自带 bash 3.2 在中文 locale 下会把中文的首字节
#       并入变量名，set -u 下直接 "unbound variable" 中断。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT"

PLATFORM="${PLATFORM:-linux/amd64}"
DOCKER_MIRROR="${DOCKER_MIRROR:-docker.m.daocloud.io/library/}"

# 构建标识（不是版本号）：只用于「这个包/这个镜像是什么时候、哪次提交打出来的」。
GIT_REVISION="$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DIRTY="clean"
if git rev-parse --git-dir >/dev/null 2>&1 && [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  DIRTY="dirty"
fi

# 固定标识：包名、解压目录、镜像 tag 都不带版本号 —— 上传与发版命令因此逐字可复用。
CLOUD_IMAGE="agent-task-board-cloud:latest"
IMAGE_TARBALL_NAME="agent-task-board-cloud-images.tar.gz"
OUT_DIR="dist/agent-task-board-cloud-prod"
TARBALL="dist/agent-task-board-cloud-prod.tar.gz"

log() { printf '\033[36m[bundle]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[bundle] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m[bundle] %s\033[0m\n' "$*" >&2; exit 1; }
image_arch() { docker image inspect "$1" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true; }

command -v docker >/dev/null 2>&1 || die "未安装 docker CLI"
docker info >/dev/null 2>&1 || die "docker 守护进程未就绪"
[[ -f apps/cloud/package.json ]] || die "请在仓库根目录执行（缺 apps/cloud/package.json）"

log "目标平台 ${PLATFORM}　构建标识 ${GIT_REVISION}（${BUILD_TIME}，工作区 ${DIRTY}）"
if [[ "$DIRTY" == dirty ]]; then
  warn "工作区有未提交改动：产物里的代码不等于 ${GIT_REVISION} 这个 commit，且无法按 commit 复现。建议先提交再打包。"
fi
case "$PLATFORM" in
  *arm*) log "注意：arm64 交叉构建会走模拟执行，npm 依赖安装会明显变慢" ;;
esac

log "构建服务端镜像 ${CLOUD_IMAGE}（含 nest build + prisma generate，首次需拉 node 基础镜像）"
docker buildx build --platform "$PLATFORM" -f apps/cloud/Dockerfile \
  --build-arg "GIT_REVISION=${GIT_REVISION}" \
  --build-arg "BUILD_TIME=${BUILD_TIME}" \
  -t "$CLOUD_IMAGE" --load .

log "准备 Caddy 边缘镜像 ${DOCKER_MIRROR}caddy:2-alpine → 统一 retag 为 caddy:2-alpine"
# 服务器侧 compose 里 image 是 caddy:2-alpine：离线部署要求服务器不联网，这里归一成官方名，
# load 完直接命中，绝不触发联网 pull。同名 tag 是别的架构留下的（改过 PLATFORM）时必须重拉。
if [[ "$(image_arch caddy:2-alpine)" != "$PLATFORM" ]]; then
  if [[ "$(image_arch "${DOCKER_MIRROR}caddy:2-alpine")" != "$PLATFORM" ]]; then
    docker pull --platform "$PLATFORM" "${DOCKER_MIRROR}caddy:2-alpine"
  fi
  docker tag "${DOCKER_MIRROR}caddy:2-alpine" caddy:2-alpine
fi

log "自检：两个镜像的架构必须都是 $PLATFORM"
for img in "$CLOUD_IMAGE" caddy:2-alpine; do
  arch="$(image_arch "$img")"
  case "$arch" in
    "$PLATFORM") ;;
    "" | unknown/*) warn "$img 的架构判不出来（${arch:-无}），请确认服务器同为 $PLATFORM" ;;
    *) die "$img 是 ${arch}，与目标 $PLATFORM 不符" ;;
  esac
done

log "导出镜像包（cloud + caddy，约 250MB，gzip 后视分层而定，耗时 1-2 分钟）"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/images"
docker save "$CLOUD_IMAGE" caddy:2-alpine | gzip -6 > "$OUT_DIR/images/$IMAGE_TARBALL_NAME"

cp apps/cloud/deploy/docker-compose.prod.yml apps/cloud/deploy/Caddyfile \
  apps/cloud/deploy/deploy.sh apps/cloud/deploy/.env.prod.example "$OUT_DIR/"
chmod 755 "$OUT_DIR/deploy.sh"

# 构建标识清单：服务端没有版本号，用这个文件回答「这个包是哪次提交、什么时候打的」
cat > "$OUT_DIR/BUILD-INFO.txt" <<EOF
commit:     ${GIT_REVISION}
built_at:   ${BUILD_TIME}
platform:   ${PLATFORM}
worktree:   ${DIRTY}
images:     ${CLOUD_IMAGE}, caddy:2-alpine
说明：服务端不带版本号；线上实际跑的镜像看 docker image inspect 的
      org.opencontainers.image.revision 标签，运行中的服务看 GET /healthz 的 commit 字段。
EOF

# COPYFILE_DISABLE=1：不让 macOS tar 把 AppleDouble（._* 伴生条目）打进包
COPYFILE_DISABLE=1 tar czf "$TARBALL" -C dist "$(basename "$OUT_DIR")"
rm -rf "$OUT_DIR"

echo
log "产物：${TARBALL}（$(du -h "$TARBALL" | cut -f1)，构建标识 ${GIT_REVISION}）"
log "sha256：$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
echo
log "上传（scp 均可，会覆盖服务器上的同名旧包）：${TARBALL} → 服务器 /opt/agent-task-board-cloud/"
echo
log "服务器上首次部署（包上传到 /opt/agent-task-board-cloud，解压进该固定目录再运行，可逐字复制）："
printf '  mkdir -p /opt/agent-task-board-cloud && tar xzf /opt/agent-task-board-cloud/agent-task-board-cloud-prod.tar.gz --strip-components=1 -C /opt/agent-task-board-cloud\n'
printf '  cd /opt/agent-task-board-cloud && ./deploy.sh\n'
echo
log "服务器上发版（在 /opt/agent-task-board-cloud 里执行）："
printf '  cd /opt/agent-task-board-cloud && ./deploy.sh update\n'
