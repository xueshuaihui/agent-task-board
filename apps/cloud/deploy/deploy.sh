#!/usr/bin/env bash
#
# Agent Task Board 云端市场 · 生产运维入口（离线镜像包 + Caddy 自动 HTTPS，一键部署）
#
# 用法：
#   ./deploy.sh [镜像包.tar.gz]   首次部署：导入镜像（若未导入）→ 生成 JWT_SECRET → 体检 → 起服 → 探活。
#                                 省略参数时，会自动导入本目录 images/ 下的镜像包。
#                                 **唯一**会问你域名/邮箱的命令。
#   ./deploy.sh update <包>       发版：把在跑的镜像留成 :prev（必须在导入新镜像之前）→ 导入新镜像
#                                 → 同步包内编排/Caddyfile/缺失的 .env 键 → 升级前备份 SQLite
#                                 → 起服 → 探活，并记录到 update-history.log。**全程无交互**。
#                                 <包> 可省：在「当前目录 → 脚本目录及其上一级 → 配置目录及其上一级」
#                                 取 mtime 最新的 agent-task-board-cloud*.tar.gz。
#   ./deploy.sh rollback          回退：latest 与 :prev 互换后重新起服（不回数据库，SQLite 结构由
#                                 启动时自动迁移保证前向兼容；数据回点用 restore）。
#   ./deploy.sh check             只做配置体检
#   ./deploy.sh status            容器与健康状态（含探活输出）
#   ./deploy.sh logs [服务]       跟踪日志（cloud / caddy）
#   ./deploy.sh backup            SQLite 备份（VACUUM INTO 一致性快照 → gzip，保留最近 BACKUP_KEEP 份）
#   ./deploy.sh restore [文件] [--yes]
#                                 用备份恢复 SQLite（破坏性：先停服、覆盖库文件；需 --yes 或交互确认）
#   ./deploy.sh down              停止服务（数据卷保留）
#
# 边缘层两种归属，由 .env.prod 的 EDGE_MODE 决定（脚本会据此同步 COMPOSE_PROFILES）：
#   EDGE_MODE=caddy（默认）—— 本编排自带 caddy 终止 TLS，要求 80/443 空闲、域名 A 记录指向本机；
#   EDGE_MODE=off　　　　　—— 80/443 已被别的边缘占用（1Panel 的 OpenResty、n8n 等），
#                             caddy 不进编排，改由该边缘把站点反代到 HTTP_BIND:HTTP_PORT，
#                             此时不校验 SITE_DOMAIN/ACME_EMAIL，也不用 80/443。
# 首次部署（交互）会先探 80/443 再问域名：被非本编排的进程占着就直接问「改用 off？」，
# 答 Y（默认）即自动写好并跳过域名/邮箱，一次跑完；发版等非交互命令只报告问题、不代改配置。
#
# 运维目录固定在持久路径 /opt/agent-task-board-cloud（**不在 /tmp**——定时清理会连运维目录一起带走）。
# .env.prod 里的 CLOUD_JWT_SECRET 不可再生（换了/丢了全员掉线），脚本每次体检都会往保险位
# ~/.agent-task-board-cloud/.env.prod 留一份（权限 600），目录里缺配置时自动回填；
# 另请再存一份到服务器之外（./deploy.sh backup 的产物同理）。
# 写法约束：$VAR 紧跟中文时必须写 ${VAR}——macOS 自带 bash 3.2 在中文 locale 下会把它并进变量名，
#   set -u 下直接 "unbound variable" 中断。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_EXAMPLE="$SCRIPT_DIR/.env.prod.example"
# 配置真身的**稳定副本**（保险位）：JWT_SECRET 不可再生，每次体检留一份，配置缺失时自动回填。
ENV_VAULT="${ATB_ENV_VAULT:-${HOME:-/root}/.agent-task-board-cloud/.env.prod}"
# 编排里 container_name 的前缀，用于反查在跑的编排目录。
CONTAINER_PREFIX="atb-cloud-prod-"

# 反查「正在服务的那套编排在哪个目录」：compose 打在容器上的 working_dir 标签是运行时事实，
# 与你在哪里执行脚本无关。要求该目录里确实还有编排文件（无源容器不算）。
detect_running_compose_dir() {
  command -v docker >/dev/null 2>&1 || return 1
  local cid d
  while read -r cid; do
    [[ -n "$cid" ]] || continue
    d="$(docker inspect "$cid" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
    [[ -n "$d" && "$d" != "<no value>" ]] || continue
    [[ -f "$d/docker-compose.prod.yml" ]] || continue
    printf '%s' "$d"
    return 0
  done < <(docker ps -a --filter "name=${CONTAINER_PREFIX}" --format '{{.ID}}' 2>/dev/null || true)
  return 1
}

# 配置真身所在目录：ATB_DEPLOY_DIR 显式指定 → 在跑容器反查 → 脚本所在目录（只在没有服务在跑时才是答案）。
DEPLOY_DIR="${ATB_DEPLOY_DIR:-}"
DIR_SOURCE=""
if [[ -n "$DEPLOY_DIR" ]]; then
  DIR_SOURCE="ATB_DEPLOY_DIR 指定"
else
  DEPLOY_DIR="$(detect_running_compose_dir || true)"
  if [[ -n "$DEPLOY_DIR" ]]; then
    DIR_SOURCE="从在跑的容器反查"
  fi
fi
if [[ -z "$DEPLOY_DIR" ]]; then
  DEPLOY_DIR="$SCRIPT_DIR"
  DIR_SOURCE="脚本所在目录（未发现正在运行的服务）"
fi

ENV_FILE="$DEPLOY_DIR/.env.prod"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
  # 选定/反查到的目录里没有编排文件：退回脚本自带的那份。
  COMPOSE_FILE="$SCRIPT_DIR/docker-compose.prod.yml"
  DEPLOY_DIR="$SCRIPT_DIR"
  DIR_SOURCE="脚本所在目录（先前那个目录里没有编排文件）"
fi

DEV_JWT_SECRET="dev-secret-change-me"
CLOUD_IMAGE="agent-task-board-cloud:latest"
CLOUD_IMAGE_PREV="agent-task-board-cloud:prev"

# 由 preflight 赋值：images = 用已导入的镜像（离线包）
DEPLOY_MODE=""

# 是否允许「向导式补全」：只有首次部署（cmd_deploy）置 1。发版/回退/备份/体检一律 0 ——
# 凭空换 CLOUD_JWT_SECRET 会让所有会话失效，那不是「配置不完整」而是事故。
PREFLIGHT_INTERACTIVE=0
# 只有首次部署允许从模板创建配置文件；其余命令发现配置缺失一律停下。
ALLOW_ENV_CREATE=0

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

# 体检的问题项：只收集、末尾一次性编号列全（长输出里 warn 会滚出屏幕，失败不该是猜谜）。
PROBLEMS=()
problem() { PROBLEMS+=("$1"); }

# 兼容只有 docker-compose v1 的老宿主机。
DC_BIN=""
dc_bin() {
  if [[ -n "$DC_BIN" ]]; then printf '%s' "$DC_BIN"; return; fi
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DC_BIN="docker compose"
  else
    DC_BIN="docker-compose"
  fi
  printf '%s' "$DC_BIN"
}

EDGE_MODE=""
edge_mode() {
  if [[ -z "$EDGE_MODE" ]]; then
    local m
    m="$(var EDGE_MODE)"
    m="${m:-caddy}"
    case "$m" in
      caddy | off) ;;
      *)
        warn "EDGE_MODE 取值非法：${m}（只支持 caddy / off），按 caddy 处理"
        m="caddy"
        ;;
    esac
    EDGE_MODE="$m"
  fi
  printf '%s' "$EDGE_MODE"
}

# 把 EDGE_MODE 翻译成 COMPOSE_PROFILES（决定 caddy 是否参与编排），并写回 env 文件保持两边一致。
apply_edge_profile() {
  local m
  m="$(edge_mode)"
  if [[ "$m" == caddy ]]; then
    export COMPOSE_PROFILES="edge"
  else
    unset COMPOSE_PROFILES
  fi
  if [[ "$(var COMPOSE_PROFILES)" != "${COMPOSE_PROFILES:-}" ]]; then
    var_set COMPOSE_PROFILES "${COMPOSE_PROFILES:-}"
  fi
}

compose() {
  local bin
  apply_edge_profile
  bin="$(dc_bin)"
  $bin --project-directory "$DEPLOY_DIR" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# 读取 env 文件里的某个键（不 source：密钥可能含特殊字符；后出现的赋值生效）
var() {
  awk -v k="$1" '
    !/=/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*#/) next
      i = index(line, "=")
      key = substr(line, 1, i - 1)
      gsub(/[[:space:]]/, "", key)
      if (key == k) {
        v = substr(line, i + 1)
        gsub(/^[[:space:]]+/, "", v)
        gsub(/[[:space:]]+$/, "", v)
      }
    }
    END { print v }
  ' "$ENV_FILE" 2>/dev/null || true
}

# 改写（或补写）env 文件中的一个键
var_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    {
      line = $0
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*#/ || line !~ /=/) { print; next }
      i = index(line, "=")
      key = substr(line, 1, i - 1)
      gsub(/[[:space:]]/, "", key)
      if (key == k && !done) { print k "=" v; done = 1; next }
      print
    }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

rand_hex() {
  local n="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$((n / 2))"
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$n"
  fi
}

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

image_id() {
  docker image inspect "$1" --format '{{.Id}}' 2>/dev/null | cut -c8-19 || true
}

image_revision() {
  docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true
}

# 把「正在跑的镜像」原样留成 :prev（回退用）。必须在导入新镜像之前调用：
# latest 是唯一的活动引用，一旦被新镜像占走，在跑的那份就成了无名镜像，再也切不回去。
snapshot_prev_image() {
  local ref=""
  if docker inspect atb-cloud-prod-cloud >/dev/null 2>&1; then
    ref="$(docker inspect --format '{{.Config.Image}}' atb-cloud-prod-cloud 2>/dev/null || true)"
  fi
  if [[ -z "$ref" ]]; then
    log "没有正在运行的 cloud 容器（首次部署？），无需留 :prev"
    return 0
  fi
  docker tag "$ref" "$CLOUD_IMAGE_PREV"
  log "在跑的服务端镜像留为回退用：$ref → $CLOUD_IMAGE_PREV"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "未安装 docker CLI"
  docker info >/dev/null 2>&1 || die "docker 守护进程未就绪（Docker Desktop / dockerd 未启动？）"
}

# ── 包内配置同步（update 的一条命令之所以成立，就靠这里）────────────────────────
# 每个被覆盖的文件先留 .bak-<时间戳>；.env 只「补缺失键」，绝不覆盖已有值（密钥不能被模板冲掉）。
# $1 = 包里解出来的目录（含 docker-compose.prod.yml）
sync_bundle_config() {
  local src="$1" bc="" cf="" tgt="" bak="" keep
  [[ -n "$src" && -d "$src" ]] || return 0

  bc="$src/docker-compose.prod.yml"
  if [[ ! -f "$bc" ]]; then
    warn "包里没有编排文件，跳过编排同步（若这一版改过编排需手工同步）"
  elif cmp -s "$bc" "$COMPOSE_FILE"; then
    log "编排已是最新：$(basename "$COMPOSE_FILE")"
  else
    bak="${COMPOSE_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$COMPOSE_FILE" "$bak"
    cp "$bc" "$COMPOSE_FILE"
    log "已同步编排：$(basename "$bc") → $COMPOSE_FILE（原文件备份：$bak）"
    echo "----- 编排差异（旧 → 新）-----"
    diff -u "$bak" "$COMPOSE_FILE" | sed -n '3,60p' || true
    echo "-----------------------------"
  fi

  if [[ "$(edge_mode)" == caddy ]]; then
    cf="$src/Caddyfile"
    tgt="$DEPLOY_DIR/Caddyfile"
    if [[ -f "$cf" && ! -f "$tgt" ]]; then
      cp "$cf" "$tgt"
      log "已同步 Caddyfile → ${tgt}"
    elif [[ -f "$cf" && -f "$tgt" ]] && ! cmp -s "$cf" "$tgt"; then
      bak="${tgt}.bak-$(date +%Y%m%d-%H%M%S)"
      cp -p "$tgt" "$bak"
      cp "$cf" "$tgt"
      log "已同步 Caddyfile → ${tgt}（原文件备份：$bak）"
    fi
  fi

  # 已知的 .env 键：只补缺失，不覆盖已有值
  for keep in EDGE_MODE COMPOSE_PROFILES HTTP_BIND HTTP_PORT BACKUP_DIR BACKUP_KEEP; do
    if [[ -z "$(var "$keep")" ]]; then
      local val=""
      case "$keep" in
        EDGE_MODE) val="$(awk -F= '/^EDGE_MODE=/{print $2}' "$src/.env.prod.example" 2>/dev/null || true)" ;;
        COMPOSE_PROFILES) val="$(awk -F= '/^COMPOSE_PROFILES=/{print $2}' "$src/.env.prod.example" 2>/dev/null || true)" ;;
        HTTP_BIND) val="127.0.0.1" ;;
        HTTP_PORT) val="7789" ;;
        BACKUP_DIR) val="$DEPLOY_DIR/backups" ;;
        BACKUP_KEEP) val="14" ;;
      esac
      if [[ -n "$val" ]]; then
        var_set "$keep" "$val"
        log "已补 ${keep}=${val}"
      fi
    fi
  done
}

# 无参 update 的候选目录（规范化 + 去重）：当前目录 → 脚本目录及其上一级 → 配置目录及其上一级。
# 刻意不扫 images/：那是首次部署那份镜像，导入它等于原地不动，输出却像一次正常更新。
update_pkg_dirs() {
  local d abs seen=""
  for d in "$PWD" "$SCRIPT_DIR" "$SCRIPT_DIR/.." "$DEPLOY_DIR" "$DEPLOY_DIR/.."; do
    [[ -d "$d" ]] || continue
    abs="$(cd "$d" && pwd)"
    case " $seen " in *" $abs "*) continue ;; esac
    seen="${seen} ${abs}"
    printf '%s\n' "$abs"
  done
}

pkg_dirs_hint() {
  local d out=""
  while IFS= read -r d; do out="${out}　　　　${d}"$'\n'; done < <(update_pkg_dirs)
  printf '%s' "$out"
}

mtime_epoch() {
  date -r "$1" '+%s' 2>/dev/null || printf '0'
}

# 不填更新包时的默认选择：在候选目录里取**时间最新**的一份（按时间不按目录顺序，
# 免得目录里残留的旧包抢先；0 字节占位文件跳过）。
default_update_pkg() {
  local d f t best="" best_t=0
  while IFS= read -r d; do
    for f in "$d"/agent-task-board-cloud*.tar.gz; do
      [[ -s "$f" ]] || continue
      t="$(mtime_epoch "$f")"
      if [[ -z "$best" || "$t" -gt "$best_t" ]]; then best="$f"; best_t="$t"; fi
    done
  done < <(update_pkg_dirs)
  [[ -n "$best" ]] && printf '%s' "$best"
}

load_image_tar() {
  local file="$1"
  [[ -f "$file" ]] || die "镜像包不存在：$file"
  require_docker
  log "导入镜像：${file}（$(du -h "$file" | cut -f1)，约 1-2 分钟）" >&2
  docker load -i "$file"
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    return 0
  fi
  if [[ $ALLOW_ENV_CREATE -ne 1 ]]; then
    die "配置目录里没有 $(basename "$ENV_FILE")：${DEPLOY_DIR}［${DIR_SOURCE}］
　　　这不是一份已部署的配置。本机上若有正在运行的服务，脚本会自动反查到它的编排目录；
　　　这次没反查到，所以落到这里。若配置确实在别处，用 ATB_DEPLOY_DIR 指向那份编排目录，例如：
　　　　　ATB_DEPLOY_DIR=/opt/agent-task-board-cloud $0 status
　　　首次部署才从模板创建配置，此时应当直接执行 $0（不带子命令）。"
  fi
  [[ -f "$ENV_EXAMPLE" ]] || die "缺少 $ENV_FILE 与模板 $ENV_EXAMPLE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "已从模板创建 $ENV_FILE"
}

# 配置副本的留存与回填：运维目录被清走后，重新解压到同一路径即可把 JWT_SECRET 原样填回来。
# 幂等：按内容比（从副本回填后 mtime 会更新，按时间比会立刻又回写一遍，噪音日志）。
sync_env_vault() {
  local vault_dir
  vault_dir="$(dirname "$ENV_VAULT")"
  if [[ -f "$ENV_FILE" && -s "$ENV_FILE" ]]; then
    if [[ -f "$ENV_VAULT" ]] && cmp -s "$ENV_FILE" "$ENV_VAULT"; then
      return 0
    fi
    if mkdir -p "$vault_dir" 2>/dev/null && cp "$ENV_FILE" "$ENV_VAULT" 2>/dev/null; then
      chmod 600 "$ENV_VAULT" 2>/dev/null || true
      log "配置副本已留存：${ENV_VAULT}（另请存一份到服务器之外）"
    else
      warn "无法把配置副本写到 ${ENV_VAULT} —— 请自行备份 ${ENV_FILE}（JWT_SECRET 丢了全员掉线）"
    fi
    return 0
  fi
  if [[ -f "$ENV_VAULT" && -s "$ENV_VAULT" ]]; then
    if ! mkdir -p "$DEPLOY_DIR" 2>/dev/null; then
      warn "配置目录不存在且无法创建：${DEPLOY_DIR}"
      return 0
    fi
    if cp "$ENV_VAULT" "$ENV_FILE" 2>/dev/null; then
      chmod 600 "$ENV_FILE" 2>/dev/null || true
      log "配置目录里没有 $(basename "$ENV_FILE")，已从副本恢复：${ENV_VAULT}"
    else
      warn "无法从副本恢复配置：${ENV_VAULT} → ${ENV_FILE}"
    fi
  fi
}

# 某个 TCP 端口是否被「非本编排的进程」占着（本编排自己的 caddy 正占着 80/443 不算冲突）。
port_used_by_others() {
  local p="$1"
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || return 1
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q atb-cloud-prod-caddy; then
    return 1
  fi
  return 0
}

port_owner() {
  local p="$1" proc ctr
  proc="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { print $1 }' | sort -u | paste -sd, - || true)"
  ctr="$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | awk -v pat=":$p->" 'index($0, pat) { print $1 }' | paste -sd, - || true)"
  if [[ -n "$ctr" ]]; then
    printf '%s（容器 %s）' "${proc:-占用中}" "$ctr"
  else
    printf '%s' "${proc:-占用中}"
  fi
}

# ---------- 配置体检：拦住一切开发/测试期取值 ----------
preflight() {
  # 「配置来源」必须最先打印：定位「发版时为什么来问我域名」这类困惑的唯一线索。
  log "配置来源：${DEPLOY_DIR}［${DIR_SOURCE}］（${COMPOSE_FILE} + $(basename "$ENV_FILE")）"
  if [[ "$DEPLOY_DIR" != "$SCRIPT_DIR" ]]; then
    log "　　你在 ${SCRIPT_DIR} 执行；配置取自上面那个目录（在跑的那份为准，与执行位置无关）"
  fi
  case "$DEPLOY_DIR" in
    /tmp | /tmp/* | /var/tmp | /var/tmp/*)
      die "配置目录在临时目录 ${DEPLOY_DIR}：/tmp 会被重启与定时清理带走，请迁移到 /opt/agent-task-board-cloud"
      ;;
  esac
  sync_env_vault
  ensure_env_file
  require_docker

  local jwt port gen_secret=0
  PROBLEMS=()
  jwt="$(var CLOUD_JWT_SECRET)"
  port="$(var HTTP_PORT)"

  if [[ -z "$jwt" ]]; then
    if [[ $PREFLIGHT_INTERACTIVE -eq 1 ]]; then
      jwt="$(rand_hex 64)"
      var_set CLOUD_JWT_SECRET "$jwt"
      gen_secret=1
      log "已生成 CLOUD_JWT_SECRET 并写入 ${ENV_FILE}（更换后所有登录会话失效，请连同该文件一起备份）"
    else
      problem "CLOUD_JWT_SECRET 为空：这份配置没配好（非首次部署不代生成——换密钥会让所有登录会话失效）"
    fi
  fi
  if [[ "$jwt" == "$DEV_JWT_SECRET" ]]; then
    problem "CLOUD_JWT_SECRET 仍是开发默认值"
  fi
  if [[ -n "$jwt" && ${#jwt} -lt 32 ]]; then
    problem "CLOUD_JWT_SECRET 长度不足 32（当前 ${#jwt} 位）"
  fi

  if [[ ! "$port" =~ ^[0-9]+$ ]]; then
    problem "HTTP_PORT 非数字：$port"
  fi

  local bind
  bind="$(var HTTP_BIND)"
  case "$bind" in
    "" | 127.0.0.1 | localhost | 0.0.0.0) ;;
    *)
      problem "HTTP_BIND 只支持 127.0.0.1（默认，仅回环）或 0.0.0.0（无边缘、局域网直连）：$bind"
      ;;
  esac

  # 边缘层分流：先探清 80/443 的占用事实，再据此定边缘归属，最后才问域名/邮箱。
  local edge site email p80=0 p443=0 busy ans
  if port_used_by_others 80; then p80=1; fi
  if port_used_by_others 443; then p443=1; fi
  if (( p80 || p443 )) && [[ "$(edge_mode)" == caddy ]] && [[ $PREFLIGHT_INTERACTIVE -eq 1 && -t 0 ]]; then
    busy=""
    (( p80 )) && busy="80（$(port_owner 80)）" || true
    (( p443 )) && busy="${busy}${busy:+、}443（$(port_owner 443)）" || true
    log "80/443 已被别的进程占用：${busy}"
    log "　　EDGE_MODE=caddy 时 caddy 要独占 80/443 做 ACME 验证与 HTTPS 终止，现在起不来。"
    printf '%s' '[deploy] 改用 EDGE_MODE=off（交给这个既有边缘反代，无需域名与邮箱）？[Y/n] '
    read -r ans || ans=""
    case "${ans:-Y}" in
      y | Y | yes | YES)
        var_set EDGE_MODE off
        EDGE_MODE=""        # 清掉缓存，让 edge_mode() 重新读文件
        apply_edge_profile  # 同步 COMPOSE_PROFILES，避免手工起服时又把 caddy 拉起来抢 80/443
        log "已把 ${ENV_FILE} 的 EDGE_MODE 改为 off，接着按 off 模式继续部署"
        log "　　想改回 caddy：腾空 80/443 后把该键改回 caddy 重跑即可"
        ;;
      *)
        log "保留 EDGE_MODE=caddy —— 本次部署前需先腾空 80/443，否则 caddy 起不来"
        ;;
    esac
  fi
  edge="$(edge_mode)"
  if [[ "$edge" == caddy ]]; then
    # 域名与邮箱无法自动推断。只有首次部署（交互）才提示输入并写回；其余命令发现仍是
    # 空值/模板占位就直接报错——这类命令还来问域名，说明读的不是线上那份配置。
    site="$(var SITE_DOMAIN)"
    if [[ -z "$site" || "$site" == *.example.com ]] && [[ $PREFLIGHT_INTERACTIVE -eq 1 && -t 0 ]]; then
      printf '输入对外域名（SITE_DOMAIN，如 cloud.example.com）：'
      read -r site
      [[ -n "$site" ]] && var_set SITE_DOMAIN "$site"
    fi
    site="$(var SITE_DOMAIN)"
    if [[ -z "$site" ]]; then
      problem "SITE_DOMAIN 未设置（Caddy 自动 HTTPS 需要真实域名，A 记录指向本机）"
    elif [[ "$site" == *.example.com ]]; then
      problem "SITE_DOMAIN 还是模板占位值：${site} —— 这份配置没填过域名，多半不是线上那份（配置来源见首行）"
    elif [[ "$site" == localhost || "$site" == "127.0.0.1" || "$site" == "_" ]]; then
      problem "SITE_DOMAIN 不能是 localhost/127.0.0.1/_，ACME 无法对其签发证书：$site"
    fi
    email="$(var ACME_EMAIL)"
    if [[ -z "$email" || "$email" == *@example.com ]] && [[ $PREFLIGHT_INTERACTIVE -eq 1 && -t 0 ]]; then
      printf "输入 Let's Encrypt 注册邮箱（ACME_EMAIL，用于证书过期提醒）："
      read -r email
      [[ -n "$email" ]] && var_set ACME_EMAIL "$email"
    fi
    email="$(var ACME_EMAIL)"
    if [[ -z "$email" ]]; then
      problem "ACME_EMAIL 未设置（Let's Encrypt 注册邮箱）"
    elif [[ "$email" == *@example.com ]]; then
      problem "ACME_EMAIL 还是模板占位值：${email}（这份配置没填过邮箱）"
    elif [[ ! "$email" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
      problem "ACME_EMAIL 不是合法邮箱：$email"
    fi
    if (( p80 )); then
      problem "端口 80 已被占用（$(port_owner 80)）：caddy 要独占 80/443 —— 腾空端口，或把 EDGE_MODE 改为 off 交给既有边缘反代"
    fi
    if (( p443 )); then
      problem "端口 443 已被占用（$(port_owner 443)）：caddy 要独占 80/443 —— 腾空端口，或把 EDGE_MODE 改为 off 交给既有边缘反代"
    fi
  else
    log "边缘层：EDGE_MODE=off —— 不启用 caddy，80/443 留给既有边缘（把站点反代到 http://${bind:-127.0.0.1}:${port}）"
  fi

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q atb-cloud-prod-cloud; then
      : # 本编排自己的 cloud 容器，正常
    else
      problem "端口 $port 已被其他进程占用，请修改 HTTP_PORT（EDGE_MODE=caddy 时 80/443 由 caddy 独占，不要与之冲突）"
    fi
  fi

  # 交付模式：没有源码就必须已经 load 过镜像（离线包部署；本项目不支持服务器就地构建）
  if image_exists "$CLOUD_IMAGE"; then
    DEPLOY_MODE="images"
    log "交付模式：离线镜像 ${CLOUD_IMAGE}"
  else
    problem "本地没有已导入的镜像 ${CLOUD_IMAGE}。先导入离线包：$0 load <images/agent-task-board-cloud-images.tar.gz>，或直接执行 $0 <镜像包.tar.gz>"
  fi

  mkdir -p "$(backup_dir)" 2>/dev/null || true

  if [[ ${#PROBLEMS[@]} -gt 0 ]]; then
    local plist="" idx=1 p extra=""
    for p in "${PROBLEMS[@]}"; do
      plist="${plist}
　　　${idx}) ${p}"
      idx=$((idx + 1))
    done
    case " ${PROBLEMS[*]} " in
      *端口* | *SITE_DOMAIN* | *ACME_EMAIL* | *EDGE_MODE*)
        extra="
　　　提示：80/443 已被别的边缘占用（1Panel 的 OpenResty、n8n 等）时，正确做法是把
　　　　　　${ENV_FILE} 里的 EDGE_MODE 改成 off（此时域名与邮箱都不必填），
　　　　　　再到那个边缘把站点反代到 http://$(var HTTP_BIND):$(var HTTP_PORT)。"
        ;;
    esac
    die "配置体检未通过（共 ${#PROBLEMS[@]} 项）：${plist}
${extra}
　　　改完重跑本命令；只体检不部署：$0 check。
　　　配置来源：${DEPLOY_DIR}［${DIR_SOURCE}］，配置真身：${ENV_FILE}。"
  fi
  # 首次部署可能刚生成了 JWT_SECRET，收尾时再留一次副本。
  sync_env_vault
  log "配置体检通过：入口=http://${bind:-127.0.0.1}:${port} 边缘=$edge"
}

probe_url() {
  printf 'http://127.0.0.1:%s/healthz' "$(var HTTP_PORT)"
}

wait_healthy() {
  local url i
  url="$(probe_url)"
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      log "服务就绪：$url"
      curl -fsS "$url"
      echo
      return 0
    fi
    sleep 2
  done
  warn "探测超时，当前状态："
  compose ps || true
  compose logs --tail 40 cloud || true
  die "请查看上面的日志定位问题"
}

start_and_probe() {
  log "起服：cloud（启动时自动执行 SQLite 迁移，幂等）→ caddy（EDGE_MODE=caddy 时）"
  compose up -d
  wait_healthy
}

cmd_deploy() {
  local pkg="${1:-}" auto_tar d
  ALLOW_ENV_CREATE=1
  PREFLIGHT_INTERACTIVE=1
  ensure_env_file
  require_docker
  # 起服前先把在跑的镜像留成 :prev：本命令也可能带新包上来（不是首次部署），不留档回退无从下手。
  snapshot_prev_image
  if [[ -n "$pkg" ]]; then
    [[ -f "$pkg" ]] || die "镜像包不存在：$pkg"
    # 把外层 bundle 误当镜像包是高频手误：先认出来并给出对症的做法。
    local first=""
    first="$(tar tzf "$pkg" 2>/dev/null | head -n 1 || true)"
    case "$first" in
      agent-task-board-cloud-prod | agent-task-board-cloud-prod/*)
        die "这是离线包的**外层** bundle，不是镜像包：$pkg
　　　首次部署：解压到固定目录再运行（命令逐字可复制）
　　　　　mkdir -p /opt/agent-task-board-cloud
　　　　　tar xzf $pkg --strip-components=1 -C /opt/agent-task-board-cloud
　　　　　cd /opt/agent-task-board-cloud && ./deploy.sh
　　　已有服务要发版：$0 update $pkg"
        ;;
    esac
    load_image_tar "$pkg"
  else
    if ! image_exists "$CLOUD_IMAGE"; then
      auto_tar=""
      for d in "$SCRIPT_DIR/images" "$DEPLOY_DIR/images"; do
        if [[ -z "$auto_tar" && -f "$d/agent-task-board-cloud-images.tar.gz" ]]; then
          auto_tar="$d/agent-task-board-cloud-images.tar.gz"
        fi
      done
      if [[ -n "$auto_tar" && -f "$auto_tar" ]]; then
        log "未检测到已导入镜像，自动载入包内镜像：$auto_tar"
        load_image_tar "$auto_tar"
      else
        die "本地没有 ${CLOUD_IMAGE} 镜像，且 ${SCRIPT_DIR}/images/ 下没有可自动导入的镜像包；请先执行 $0 load <包> 或 $0 <包>"
      fi
    fi
  fi
  preflight
  log "跳过构建：直接使用已导入的镜像 ${CLOUD_IMAGE}（含 caddy:2-alpine）"
  start_and_probe
  log "探活入口（回环）：$(probe_url)"
  if [[ "$(edge_mode)" == caddy ]]; then
    log "对外访问：https://$(var SITE_DOMAIN)　（caddy 已自动向 Let's Encrypt 申请证书，全站反代到 cloud）"
  else
    log "对外访问：由外部边缘接管（EDGE_MODE=off）——请确认已有站点反代到 http://$(var HTTP_BIND):$(var HTTP_PORT)"
  fi
}

cmd_load() {
  local file="${1:-}"
  if [[ -z "$file" ]]; then
    file="$SCRIPT_DIR/images/agent-task-board-cloud-images.tar.gz"
    [[ -f "$file" ]] || die "用法：$0 load <images/agent-task-board-cloud-images.tar.gz>"
    log "未指定路径，使用包内镜像：$file"
  fi
  load_image_tar "$file"
  log "本地镜像："
  docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep -E 'agent-task-board-cloud:latest|caddy:2-alpine' || true
  log "镜像已导入。下一步直接执行 $0 即可起服（或 $0 <镜像包.tar.gz> 一步完成导入+起服）"
}

update_history() {
  printf '%s\n' "$*" >>"${DEPLOY_DIR}/update-history.log"
}

cmd_update() {
  local pkg="${1:-}" work="" src_dir="" image_tar="" loaded="" new_id="" prev_id=""
  ensure_env_file
  require_docker
  if [[ -z "$pkg" ]]; then
    pkg="$(default_update_pkg)" || pkg=""
    [[ -n "$pkg" ]] || die "找不到可用的更新包。用法：$0 update <agent-task-board-cloud-prod.tar.gz｜已解压的目录>
　　　省略路径时，会依次在下列目录里取最新一份 agent-task-board-cloud*.tar.gz：
$(pkg_dirs_hint)
　　　把新包放到上述任一目录，或直接把路径写上。"
    log "未指定更新包 → 取最新一份：${pkg}　$(du -h "$pkg" | cut -f1)，$(date -r "$pkg" '+%F %T')"
  fi
  [[ -e "$pkg" ]] || die "更新包不存在：$pkg"

  # ── 顺序要紧：先把在跑的那份留成 :prev，再导入新镜像。
  snapshot_prev_image
  prev_id="$(image_id "$CLOUD_IMAGE_PREV")"

  if [[ -d "$pkg" ]]; then
    src_dir="$pkg"
    image_tar="$src_dir/images/agent-task-board-cloud-images.tar.gz"
    [[ -f "$image_tar" ]] || die "目录里没有 images/agent-task-board-cloud-images.tar.gz：$src_dir"
    loaded="$(load_image_tar "$image_tar")"
  elif loaded="$(docker load -i "$pkg" 2>&1)"; then
    # 直接给的就是镜像包，无需解开外层 bundle
    image_tar="$pkg"
    log "已导入镜像包：${pkg}（$(du -h "$pkg" | cut -f1)）" >&2
  else
    work="$(mktemp -d)"
    log "不是镜像包，按离线 bundle 解开：$pkg"
    tar xzf "$pkg" -C "$work" || { rm -rf "$work"; die "解压失败：$pkg"; }
    src_dir="$(find "$work" -maxdepth 2 -type d -name images 2>/dev/null | head -n 1 || true)"
    [[ -n "$src_dir" ]] || { rm -rf "$work"; die "包里没有 images/ 目录：${pkg}（不是 bundle.sh 的产物？）"; }
    src_dir="$(dirname "$src_dir")"
    image_tar="$src_dir/images/agent-task-board-cloud-images.tar.gz"
    [[ -f "$image_tar" ]] || { rm -rf "$work"; die "images/ 下没有镜像包：$pkg"; }
    loaded="$(load_image_tar "$image_tar")"
  fi
  printf '%s\n' "$loaded"

  image_exists "$CLOUD_IMAGE" || { [[ -z "$work" ]] || rm -rf "$work"; die "导入后未见 ${CLOUD_IMAGE}，镜像包不完整：$image_tar"; }
  new_id="$(image_id "$CLOUD_IMAGE")"

  # 编排/配置同步：以包内为准，否则新挂载/新变量不会生效（镜像换了、功能却是旧的）。
  if [[ -n "$src_dir" ]]; then
    sync_bundle_config "$src_dir"
  else
    warn "本次只给到镜像包（未给 bundle 包）：无法同步编排；若这一版改过 docker-compose.prod.yml，需手工同步"
  fi

  # 数据安全层：升级前自动备份 SQLite（VACUUM INTO 一致性快照）。失败即中止更新、服务器零变更。
  local backup_file=""
  backup_file="$(backup_dir)/cloud-pre-$(date +%Y%m%d-%H%M%S).db.gz"
  mkdir -p "$(backup_dir)"
  log "升级前备份数据库 → $backup_file"
  sqlite_backup "${backup_file%.gz}" || { rm -f "${backup_file%.gz}"; die "升级前备份失败，已中止本次更新（未做任何变更）"; }
  [[ -s "${backup_file%.gz}" ]] || { rm -f "${backup_file%.gz}"; die "备份文件为空，已中止本次更新（未做任何变更）"; }
  gzip -f "${backup_file%.gz}"

  if [[ -n "$prev_id" ]]; then
    log "镜像：${prev_id} → ${new_id}（latest 已指向新镜像；上一版留在 ${CLOUD_IMAGE_PREV}，可用 $0 rollback 互换回来）"
  else
    log "镜像：${new_id}（首次部署，没有可回退的上一版）"
  fi

  preflight
  start_and_probe
  [[ -n "$work" ]] && rm -rf "$work"

  update_history "$(date '+%F %T')  ${prev_id:-none} -> ${new_id}  revision=$(image_revision "$CLOUD_IMAGE")  backup=${backup_file}"
  log "更新完成（镜像 ${new_id}）　数据如有异常可用 $0 rollback 换回上一版镜像（数据回滚用 $0 restore <升级前备份> --yes）"
}

# 镜像回退：把 latest 与 :prev 互换后重新起服。是「互换」不是单向，再跑一次就切回来。
# 注意：只回退代码/镜像，不回退数据 —— 库结构由启动时自动迁移保证前向兼容；
# 数据要回到升级前时点用 restore <升级前的备份>。
cmd_rollback() {
  ensure_env_file
  require_docker
  local cur_id="" prev_id="" swap="${CLOUD_IMAGE%:*}:swap"
  image_exists "$CLOUD_IMAGE_PREV" || die "没有可回退的镜像 ${CLOUD_IMAGE_PREV}（通常是尚未执行过 update）"
  cur_id="$(image_id "$CLOUD_IMAGE")"
  prev_id="$(image_id "$CLOUD_IMAGE_PREV")"
  [[ "$cur_id" != "$prev_id" ]] || die "当前镜像与回退镜像已经是同一份（${cur_id}），无需回退"
  log "回退：${CLOUD_IMAGE}（${cur_id}）↔ ${CLOUD_IMAGE_PREV}（${prev_id}）"
  # 三步互换：先把当前镜像存到临时名，latest 切到上一版，再让 prev 指向刚才存下的那份。
  docker tag "$CLOUD_IMAGE" "$swap"
  docker tag "$CLOUD_IMAGE_PREV" "$CLOUD_IMAGE"
  docker tag "$swap" "$CLOUD_IMAGE_PREV"
  docker rmi "$swap" >/dev/null
  compose up -d
  wait_healthy
  update_history "$(date '+%F %T')  ${cur_id} -> ${prev_id}  action=rollback"
  log "已切到镜像 ${prev_id}（再跑一次 $0 rollback 可切回 ${cur_id}）"
}

cmd_status() {
  ensure_env_file
  compose ps
  curl -fsS --max-time 5 "$(probe_url)" || warn "探活失败"
  echo
}

cmd_logs() {
  ensure_env_file
  compose logs -f --tail 100 "${1:-}"
}

cmd_down() {
  ensure_env_file
  compose down
  log "已停止（数据卷 atb-cloud-prod_cloud_data 保留，未被删除）"
}

backup_dir() {
  local d
  d="$(var BACKUP_DIR)"
  [[ -n "$d" ]] || d="./backups"
  if [[ "$d" == /* ]]; then
    printf '%s' "$d"
  else
    printf '%s/%s' "$DEPLOY_DIR" "${d#./}"
  fi
}

# SQLite 一致性备份：VACUUM INTO 产出与在线库一致的快照（WAL 也不怕），再在宿主机 gzip。
# 复用 cloud 镜像里的 node + @prisma/client，服务器不需要额外装 sqlite3；
# 用独立一次性容器（不依赖 cloud 服务在跑）：挂数据卷 + 备份目录，跑完即退。
# $1 = 宿主机上待生成的 .db 文件路径（容器内即 /backup/<basename>）
sqlite_backup() {
  local out="$1" name
  name="$(basename "$out")"
  docker run --rm -v atb-cloud-prod_cloud_data:/data:ro \
    -v "$(backup_dir)":/backup \
    "$CLOUD_IMAGE" node -e '
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient({ datasourceUrl: "file:/data/cloud.db?connection_limit=1" });
    p.$queryRawUnsafe("VACUUM INTO '"'"'/backup/" + process.argv[1] + "'"'"'")
      .then(() => p.$disconnect())
      .catch((e) => { console.error(e); process.exit(1); });
  ' "$name" >&2
}

cmd_backup() {
  ensure_env_file
  local dir ts file old keep
  dir="$(backup_dir)"
  mkdir -p "$dir"
  ts="$(date +%Y%m%d-%H%M%S)"
  file="$dir/cloud-$ts.db.gz"
  log "SQLite 备份 → $file"
  sqlite_backup "$dir/cloud-$ts.db"
  [[ -s "$dir/cloud-$ts.db" ]] || die "备份文件为空，备份失败"
  gzip -f "$dir/cloud-$ts.db"
  keep="$(var BACKUP_KEEP)"
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=14
  old="$(ls -1t "$dir"/cloud-*.db.gz 2>/dev/null | tail -n +$((keep + 1)) || true)"
  if [[ -n "$old" ]]; then
    printf '%s\n' "$old" | while IFS= read -r f; do
      rm -f "$f"
    done
    log "已清理超出 ${keep} 份的旧备份"
  fi
  ls -lh "$file"
  log "备份完成。恢复：$0 restore <备份.db.gz> --yes（破坏性，见 apps/cloud/README.md §6）"
}

cmd_restore() {
  ensure_env_file
  local dir file="" newest arg confirmed=0 ans
  dir="$(backup_dir)"
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) confirmed=1 ;;
      *) file="$arg" ;;
    esac
  done
  if [[ -z "$file" ]]; then
    newest="$(ls -1t "$dir"/cloud-*.db.gz 2>/dev/null | head -n 1 || true)"
    [[ -n "$newest" ]] || die "未找到备份文件，请显式指定：$0 restore <备份.db.gz>"
    file="$newest"
  fi
  [[ -f "$file" ]] || die "备份文件不存在：$file"
  if [[ $confirmed -ne 1 ]]; then
    warn "恢复会用备份覆盖数据卷内的 cloud.db（现有数据全部丢失）。"
    [[ -t 0 ]] || die "非交互环境请追加 --yes 以确认"
    printf '输入 RESTORE 继续：'
    read -r ans
    [[ "${ans:-}" == "RESTORE" ]] || die "已取消"
  fi

  log "停止 cloud 容器"
  compose stop cloud
  log "用备份覆盖库文件：$file"
  docker run --rm -i -v atb-cloud-prod_cloud_data:/data "$CLOUD_IMAGE" sh -c \
    'cat > /data/cloud.db.restore && chown node:node /data/cloud.db.restore' < <(gzip -dc "$file")
  docker run --rm -v atb-cloud-prod_cloud_data:/data "$CLOUD_IMAGE" sh -c \
    'mv /data/cloud.db.restore /data/cloud.db && rm -f /data/cloud.db-wal /data/cloud.db-shm && chown node:node /data/cloud.db'
  log "重新起服（启动时自动核对/补迁移）"
  compose up -d
  wait_healthy
  log "恢复完成"
}

usage() {
  sed -n '/^# 用法：/,/^# 边缘层两种归属/{/^# 边缘层两种归属/d; s/^#[[:space:]]\{0,1\}//; p; }' "$0"
}

# 配置回填必须赶在一切命令之前（update/status/rollback 等的第一步就是 ensure_env_file）。
sync_env_vault

cmd="${1:-deploy}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$cmd" in
  deploy | up) cmd_deploy "${1:-}" ;;
  load) cmd_load "${1:-}" ;;
  update) cmd_update "${1:-}" ;;
  rollback) cmd_rollback ;;
  check) preflight ;;
  status) cmd_status ;;
  logs) cmd_logs "${1:-}" ;;
  backup) cmd_backup ;;
  restore) cmd_restore "$@" ;;
  down) cmd_down ;;
  -h | --help | help) usage ;;
  *)
    # 兼容把镜像包/已解压目录直接作为第一个参数的一键用法
    if [[ -e "$cmd" ]]; then
      cmd_deploy "$cmd" "$@"
    else
      usage
      exit 2
    fi
    ;;
esac
