#!/usr/bin/env bash
# 本地冒烟：只打已实现的用户侧接口，验证状态码、错误码与 4.5 的统一文案。
# 用法：DATA_DIR=/tmp/atb-smoke bash scripts/smoke.sh
#
# 注意：bash 3.2 会把「双引号里的命令替换里再套双引号」拆词，所以带 JSON 的调用一律先赋值给
# 变量再交给 check，不要写成 check x y "$(code POST p "{...}")"。
set -uo pipefail

BASE=${BASE:-http://127.0.0.1:7799/api/v1}
DATA_DIR=${DATA_DIR:-/tmp/atb-smoke}
T=$(cat "${DATA_DIR}/dev-ui-token")
AUTH="Authorization: Bearer ${T}"
pass=0
fail=0

req() { # req METHOD PATH [json]  -> 响应体
  local m=$1 p=$2 d=${3-}
  if [ -n "${d}" ]; then
    curl -s -X "${m}" "${BASE}${p}" -H "${AUTH}" -H 'content-type: application/json' -d "${d}"
  else
    curl -s -X "${m}" "${BASE}${p}" -H "${AUTH}"
  fi
}

code() { # code METHOD PATH [json]  -> HTTP 状态码
  local m=$1 p=$2 d=${3-}
  if [ -n "${d}" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X "${m}" "${BASE}${p}" -H "${AUTH}" \
      -H 'content-type: application/json' -d "${d}"
  else
    curl -s -o /dev/null -w '%{http_code}' -X "${m}" "${BASE}${p}" -H "${AUTH}"
  fi
}

check() { # check 标签 期望 实际
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1))
    printf '  ok    %-38s %s\n' "$1" "$3"
  else
    fail=$((fail + 1))
    printf '  FAIL  %-38s want=%s got=%s\n' "$1" "$2" "$3"
  fi
}

check_has() { # check_has 标签 期望子串 实际串
  case "$3" in
    *"$2"*)
      pass=$((pass + 1))
      printf '  ok    %-38s %s\n' "$1" "$2"
      ;;
    *)
      fail=$((fail + 1))
      printf '  FAIL  %-38s missing=%s got=%s\n' "$1" "$2" "$3"
      ;;
  esac
}

check_missing() { # check_missing 标签 不应出现的子串 实际串
  case "$3" in
    *"$2"*)
      fail=$((fail + 1))
      printf '  FAIL  %-38s should not contain %s\n' "$1" "$2"
      ;;
    *)
      pass=$((pass + 1))
      printf '  ok    %-38s absent\n' "$1"
      ;;
  esac
}

count_of() { # count_of 标签 期望条数 grep -o 的图案 实际串
  local n
  n=$(printf '%s' "$4" | grep -o "$3" | wc -l | tr -d ' ')
  check "$1" "$2" "${n}"
}

first_id() { # first_id JSON -> 响应体里第一个任务 id
  printf '%s' "$1" | grep -o '"id":"T-[0-9]*"' | head -1 | sed 's/.*:"//;s/"//'
}

echo "== 鉴权（20.13）"
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/board")
check "无凭证 board" 401 "${NOAUTH}"
WRONG=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/board" -H 'Authorization: Bearer nope-nope-nope-nope-nope-nope-nope')
check "错 token" 401 "${WRONG}"
OK=$(code GET /board)
check "UI token 通过" 200 "${OK}"

echo "== 创建与契约校验"
C1=$(code POST /tasks '{"title":"没有类型"}')
check "缺 type" 422 "${C1}"
C2=$(code POST /tasks '{"title":"x","type":"史诗"}')
check "未知类型" 422 "${C2}"
C3=$(code POST /tasks '{"title":"","type":"需求"}')
check "空标题" 422 "${C3}"
LONG_TAG='{"title":"x","type":"需求","tags":["这个标签的名字长过了十六个字符的上限"]}'
C4=$(code POST /tasks "${LONG_TAG}")
check "标签超长" 422 "${C4}"
GHOST='{"title":"x","type":"需求","custom_fields":{"ghost":1}}'
C5=$(code POST /tasks "${GHOST}")
check "未登记的自定义字段" 422 "${C5}"
GHOST_BODY=$(req POST /tasks "${GHOST}")
check_has "错误指明键名" 'custom_fields.ghost' "${GHOST_BODY}"

CREATE_A='{"title":"任务A","type":"需求","priority":2,"tags":["demo"]}'
A_BODY=$(req POST /tasks "${CREATE_A}")
A=$(first_id "${A_BODY}")
CREATE_B='{"title":"任务B","type":"缺陷","priority":0,"required_capabilities":["language:ts"]}'
B=$(first_id "$(req POST /tasks "${CREATE_B}")")
echo "  A=${A} B=${B}"
A_DETAIL=$(req GET "/tasks/${A}")
check_has "创建返回需求池" '"status":"BACKLOG"' "${A_DETAIL}"
CREATE_C='{"title":"任务C","type":"需求"}'
C_DETAIL=$(req POST /tasks "${CREATE_C}")
check_has "缺省优先级为 3" '"priority":3' "${C_DETAIL}"
check_has "缺省状态文案" '"status_label":"需求池"' "${C_DETAIL}"

echo "== 流转矩阵 4.5（人工可到达的格子）"
T1=$(code POST "/tasks/${A}/transition" '{"to":"READY"}')
check "需求池→待执行" 201 "${T1}"
T2=$(code POST "/tasks/${A}/transition" '{"to":"RUNNING"}')
check "待执行→执行中 禁止" 409 "${T2}"
RUNNING_BODY=$(req POST "/tasks/${A}/transition" '{"to":"RUNNING"}')
check_has "拖向执行中文案" '执行中由 Agent 认领产生' "${RUNNING_BODY}"
check_has "拖向执行中错误码" 'ILLEGAL_TRANSITION' "${RUNNING_BODY}"
T3=$(code POST "/tasks/${A}/transition" '{"to":"REVIEW"}')
check "待执行→待审核 禁止" 409 "${T3}"
T4=$(code POST "/tasks/${A}/transition" '{"to":"DONE"}')
check "待执行→已完成 禁止" 409 "${T4}"
T5=$(code POST "/tasks/${A}/transition" '{"to":"READY"}')
check "同列不落卡" 409 "${T5}"
T6=$(code POST "/tasks/${A}/transition" '{"to":"BACKLOG"}')
check "待执行→需求池 撤回" 201 "${T6}"
T7=$(code POST "/tasks/${A}/transition" '{"to":"READY"}')
check "需求池→待执行 再次" 201 "${T7}"
T8=$(code POST "/tasks/${A}/transition" '{"to":"FAILED"}')
check "待执行→异常/失败 禁止" 409 "${T8}"
T9=$(code POST "/tasks/${B}/transition" '{"to":"READY"}')
check "B 也进入待执行（阻塞不拦人工流转）" 201 "${T9}"
T10=$(code POST "/tasks/${A}/stop" '{"reason":"越界尝试"}')
check "非执行中不可停止" 409 "${T10}"

echo "== 依赖与阻塞（5 章）"
DEP_AB='{"depends_on":"'"${A}"'"}'
D1=$(code POST "/tasks/${B}/dependencies" "${DEP_AB}")
check "B 依赖 A" 201 "${D1}"
DEP_BA='{"depends_on":"'"${B}"'"}'
D2=$(code POST "/tasks/${A}/dependencies" "${DEP_BA}")
check "成环被拒" 409 "${D2}"
CYCLE=$(req POST "/tasks/${A}/dependencies" "${DEP_BA}")
check_has "成环文案" '依赖关系形成环' "${CYCLE}"
DEP_SELF='{"depends_on":"'"${B}"'"}'
D3=$(code POST "/tasks/${B}/dependencies" "${DEP_SELF}")
check "自身依赖" 409 "${D3}"
B_DETAIL=$(req GET "/tasks/${B}")
check_has "B 的阻塞数" '"blocked":{"count":1' "${B_DETAIL}"
check_has "阻塞明细带前置标题" '任务A' "${B_DETAIL}"
BLOCKED_VIEW=$(req GET '/board?view=blocked')
CLAIMABLE_VIEW=$(req GET '/board?view=claimable')
check_has "B 出现在已阻塞视图" "\"id\":\"${B}\"" "${BLOCKED_VIEW}"
check_missing "可领取视图不含被阻塞的 B" "\"id\":\"${B}\"" "${CLAIMABLE_VIEW}"
check_has "可领取视图含 A" "\"id\":\"${A}\"" "${CLAIMABLE_VIEW}"
count_of "已阻塞视图只有 1 列有卡" 1 '"tasks":\[{' "${BLOCKED_VIEW}"

echo "== 看板与列表筛选（20.7）"
BOARD=$(req GET /board)
count_of "board 六列" 6 '"label":"' "${BOARD}"
check_has "列标签用中文名" '需求池' "${BOARD}"
V1=$(code GET '/board?view=claimable')
check "view=claimable" 200 "${V1}"
V2=$(code GET '/board?view=xxx')
check "view 非法值" 422 "${V2}"
F1=$(code GET '/tasks?tags=demo')
check "单值 tags" 200 "${F1}"
F2=$(code GET '/tasks?status=BACKLOG&status=READY')
check "多值 status" 200 "${F2}"
F3=$(code GET '/tasks?priority=0,2')
check "逗号多值 priority" 200 "${F3}"
F4=$(code GET '/tasks?sort=agent_name')
check "排序白名单" 422 "${F4}"
F5=$(code GET '/tasks?archived=all')
check "archived=all" 200 "${F5}"
F6=$(code GET '/tasks?custom_fields%5BBad%20Key%5D=x')
check "custom_fields 非法键" 422 "${F6}"
F7=$(code GET '/tasks?custom_fields%5Bseverity%5D=%E9%AB%98')
check "custom_fields 合法键" 200 "${F7}"
TAG_HIT=$(req GET '/tasks?tags=demo')
check_has "tags 命中 A" "\"id\":\"${A}\"" "${TAG_HIT}"
count_of "tags 命中只有 1 条" 1 '"id":"T-' "${TAG_HIT}"
TAG_MISS=$(req GET '/tasks?tags=nope')
count_of "tags 不命中时为空" 0 '"id":"T-' "${TAG_MISS}"
CUSTOM_MISS=$(req GET '/tasks?custom_fields%5Bseverity%5D=%E9%AB%98')
count_of "未登记字段筛出空集" 0 '"id":"T-' "${CUSTOM_MISS}"
LIST=$(req GET '/tasks?page_size=50')
check_has "列表总数" '"total":3' "${LIST}"

echo "== 评论 / 置顶 / 批量"
COMMENT='{"content":"补充：仅 Safari 复现"}'
K1=$(code POST "/tasks/${A}/comments" "${COMMENT}")
check "评论写入" 201 "${K1}"
COMMENTS=$(req GET "/tasks/${A}/comments")
check_has "评论可读" '补充：仅 Safari 复现' "${COMMENTS}"
check_has "状态变更自动成评论" 'status_change' "${COMMENTS}"
count_of "默认不混入日志" 0 '"type":"log"' "${COMMENTS}"
PIN='{"pinned":true}'
K2=$(code POST "/tasks/${B}/pin" "${PIN}")
check "置顶" 201 "${K2}"
check_has "置顶后卡片可见" '"pinned":true' "$(req GET "/tasks/${B}")"
BATCH_BACK='{"ids":["'"${A}"'","'"${B}"'"],"to":"BACKLOG"}'
K3=$(code POST /tasks/batch/transition "${BATCH_BACK}")
check "批量流转" 201 "${K3}"
BATCH_BAD='{"ids":["'"${A}"'","'"${B}"'"],"to":"REVIEW"}'
K4=$(req POST /tasks/batch/transition "${BATCH_BAD}")
check_has "批量非法目标被跳过" '"skipped":[' "${K4}"
check_missing "批量非法目标不计入成功" '"succeeded":["T-' "${K4}"
BATCH_TAGS='{"ids":["'"${A}"'"],"add":["回归"]}'
K5=$(code POST /tasks/batch/tags "${BATCH_TAGS}")
check "批量加标签" 201 "${K5}"
check_has "标签已落到卡片" '回归' "$(req GET "/tasks/${A}")"
K6=$(code POST "/tasks/${A}/archive")
check "归档未完成任务被拒" 409 "${K6}"
ARCHIVE_BODY=$(req POST "/tasks/${A}/archive")
check_has "归档被拒文案" '只有已完成的任务可以归档' "${ARCHIVE_BODY}"

echo "== 错误出口"
N1=$(code GET /tasks/T-99999)
check "未知任务 404" 404 "${N1}"
N2=$(code GET /nope)
check "未知路径 404" 404 "${N2}"
N3=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/tasks" -H "${AUTH}" \
  -H 'content-type: application/json' -d '{')
check "非法 JSON 400" 400 "${N3}"
check_has "错误体统一形状" '"error":{"code"' "$(req GET /tasks/T-99999)"

echo
printf '通过 %d，失败 %d\n' "${pass}" "${fail}"
[ "${fail}" = 0 ]
