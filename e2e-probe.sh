#!/usr/bin/env bash
# 阶段一主链路端到端探针（临时验证脚本）
#
# 前提：一个**空数据目录**的 sidecar——本脚本自己造任务，多处断言依赖「此刻队列里只有我刚造的那几个」。
# 用法：ATB_E2E_DIR=<数据目录> ATB_E2E_PORT=<端口> ./e2e-probe.sh
set -uo pipefail
PORT=${ATB_E2E_PORT:-7788}
DIR=${ATB_E2E_DIR:-/tmp/atb-e2e}
B=http://127.0.0.1:${PORT}/api/v1
T=$(cat "${DIR}/dev-ui-token")
H="Authorization: Bearer $T"; J='content-type: application/json'
pass=0; fail=0
ck() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf '  ok    %-44s %s\n' "$1" "$3"
  else fail=$((fail+1)); printf  '  FAIL  %-44s 期望 %s 实得 %s\n' "$1" "$2" "$3"; fi
}
# get 表达式 JSON -> 值；解析失败或键缺失都打 BAD:前缀，避免把空串当合法值传下去
get() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v='"$1"';console.log(v===undefined||v===null?"BAD:"+d.slice(0,160):v)}catch{console.log("BAD:"+d.slice(0,160))}})'; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
# argget <js 表达式> <值>：值经 argv 进 node，不拼进 js 源码。
# 拼进源码的写法要么被单引号挡住不展开（拿到字面量 $X，恒为 0），要么撞上花括号展开。
argget() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v='"$1"';console.log(v===undefined||v===null?"BAD:"+d.slice(0,160):v)}catch{console.log("BAD:"+d.slice(0,160))}})' "$2"; }
# mk 标题 [优先级 0..3] [所需能力 json] -> 任务 id。一律填满必填的 severity；且默认带能力门槛——
# 没门槛的任务会被后面任何一次 claim 抢先领走，各段「此刻队列里只有我」的假设就塌了。
mk() {
  # 默认值必须先在双引号外落到变量里：`${3:-'[..]'}` 展开进双引号字符串时单引号是字面量，
  # 会把 JSON 拼成 "required_capabilities":'["language:java"]' 而整段创建失败。
  local caps=${3:-'["language:java"]'}
  curl -s -X POST $B/tasks -H "$H" -H "$J" -d "{\"title\":\"$1\",\"type\":\"需求\",\"priority\":${2:-2},\"required_capabilities\":${caps},\"custom_fields\":{\"severity\":\"低\"}}" | get 'j.id'
}
ready() { curl -s -X POST $B/tasks/"$1"/transition -H "$H" -H "$J" -d '{"to":"READY"}'; }
tok() { # tok 名字 [能力 json] -> 整段签发响应（Token 明文只出现这一次，13 章）
  local caps=${2:-'["language:java","tool:maven"]'}
  curl -s -X POST $B/tokens -H "$H" -H "$J" -d "{\"name\":\"$1\",\"capabilities\":${caps}}"
}
hdr() { echo "Authorization: Bearer $(echo "$1" | get 'j.token')"; }
# lb <task_id> <run_id> <lease_id> [附加 json 片段]：租约三元组拼成一个完整对象。
# 把三元组当成「已闭合的 JSON 再往后粘字段」会拼出 `{...},"progress":60}`，服务端回 400。
lb() { printf '{"task_id":"%s","run_id":"%s","lease_id":"%s"%s}' "$1" "$2" "$3" "${4:-}"; }

curl -s -X POST $B/field-defs -H "$H" -H "$J" \
  -d '{"key":"severity","label":"严重度","type":"select","required":true,"options":["高","低"]}' >/dev/null

JAVA=$(tok "qoder-java"); JH=$(hdr "$JAVA"); JID=$(echo "$JAVA" | get 'j.id')
GO=$(tok "cursor-go" '["language:go"]'); GH=$(hdr "$GO")

echo "== 1 自定义字段必填的拦截点（验收 16）=="
NID=$(curl -s -X POST $B/tasks -H "$H" -H "$J" -d '{"title":"必填拦截","type":"需求","priority":2,"required_capabilities":["language:carbon"]}' | get 'j.id')
ck "必填未填不能进待执行" "422" "$(code -X POST $B/tasks/$NID/transition -H "$H" -H "$J" -d '{"to":"READY"}')"
curl -s -X PATCH $B/tasks/$NID -H "$H" -H "$J" -d '{"custom_fields":{"severity":"高"}}' >/dev/null
ck "填齐后可进待执行" "201" "$(code -X POST $B/tasks/$NID/transition -H "$H" -H "$J" -d '{"to":"READY"}')"

echo "== 2 凭证隔离（验收 32）=="
ck "UI Token 调 claim 跨组拒绝" "403" "$(code -X POST $B/tasks/claim -H "$H" -H "$J" -d '{}')"
ck "无凭证 401" "401" "$(code $B/board)"
ck "Agent Token 调用户接口拒绝" "403" "$(code $B/board -H "$JH")"
ck "GET /tasks/:id 两类凭证均可读" "200" "$(code $B/tasks/$NID -H "$GH")"
ck "根路径不提供页面" "404" "$(code http://127.0.0.1:${PORT}/)"

echo "== 3 认领与租约（验收 5/11/12/13/35/36/40）=="
TID=$(mk "支付回调修复" 0); ready $TID >/dev/null
BID2=$(mk "并行任务二" 1); ready $BID2 >/dev/null
ck "只声明 go 的领不到 java 任务" "null" "$(curl -s -X POST $B/tasks/claim -H "$GH" -H "$J" -d '{}' | get 'j.task?j.task.id:"null"')"
ck "能力不匹配也看不见" "false" "$(curl -s $B/tasks/ready -H "$GH" | grep -qF "$TID" && echo true || echo false)"
# 验收 11：并行抢同一个队列。此刻只有 2 个可领任务，所以「非空结果恰好 2 个且互不相同」
# 就说明零重复、零多写；断言的不是谁赢。
for i in 1 2 3 4; do
  ( curl -s -X POST $B/tasks/claim -H "$JH" -H "$J" -d '{"capabilities":["language:java"]}' > "${DIR}/claim-$i.json" ) &
done
wait
IDS=""
for i in 1 2 3 4; do
  IDS="${IDS}$(cat "${DIR}/claim-$i.json" | get 'j.task?j.task.id:""'),"
done
ck "并发认领零重复" "2" "$(printf '%s' "$IDS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=d.split(",").filter(x=>x&&x!=="null"&&!x.startsWith("BAD"));console.log(new Set(a).size)})')"
# 4 个并发认领抢 2 个任务，赢家落在哪个文件不固定：按内容挑，别认死 claim-1。
CLAIM=""
for i in 1 2 3 4; do
  body=$(cat "${DIR}/claim-$i.json")
  [ "$(echo "$body" | get 'j.task?j.task.id:""')" != "" ] && CLAIM=$body && break
done
RUN=$(echo "$CLAIM" | get 'j.lease.run_id')
LEASE=$(echo "$CLAIM" | get 'j.lease.lease_id'); CID=$(echo "$CLAIM" | get 'j.task.id')
ck "认领成功进 RUNNING" "RUNNING" "$(echo "$CLAIM" | get 'j.task.status')"
ck "认领带回租约三元组" "true" "$(echo "$CLAIM" | get 'Boolean(j.lease.run_id&&j.lease.lease_id&&j.lease.expires_at)')"
ck "错误 lease 回写 410" "410" "$(code -X POST $B/tasks/$CID/progress -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "00000000-0000-0000-0000-000000000000" ',"progress":1,"message":"x"')")"
ck "心跳续租 200" "200" "$(code -X POST $B/tasks/$CID/heartbeat -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "$LEASE")")"
ck "进度更新 200" "200" "$(code -X POST $B/tasks/$CID/progress -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "$LEASE" ',"progress":60,"message":"改签名校验"')")"
ck "追加日志 200" "200" "$(code -X POST $B/tasks/$CID/logs -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "$LEASE" ',"lines":["running tests"],"level":"info"')")"
ck "Agent 日志不进「评论」Tab" "true" "$(curl -s "$B/tasks/$CID/comments?page=1" -H "$H" | get 'j.items.every(c=>c.type!=="log")')"

echo "== 4 产物与回写（验收 17）=="
printf -- '--- a/pay.ts\n+++ b/pay.ts\n@@ -1,3 +1,4 @@\n line1\n-line2\n+line2b\n+line3\n line4\n' > "${DIR}/fix.diff"
ART=$(curl -s -X POST $B/artifacts -H "$JH" -F "file=@${DIR}/fix.diff" -F "task_id=$CID" -F "run_id=$RUN" -F "lease_id=$LEASE")
AID=$(echo "$ART" | get 'j.id'); AURI=$(echo "$ART" | get 'j.uri')
ck "产物上传返回相对 uri" "true" "$(echo "$ART" | get 'String(/^artifacts\//.test(String(j.uri)))')"
# 缩略图只存在于 image 产物上，所以要单独传一张 1x1 PNG；`complete` 之后租约会失效，趁现在还有效时传。
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82' > "${DIR}/pixel.png"
IMG=$(curl -s -X POST $B/artifacts -H "$JH" -F "file=@${DIR}/pixel.png;type=image/png" -F "task_id=$CID" -F "run_id=$RUN" -F "lease_id=$LEASE")
IMGID=$(echo "$IMG" | get 'j.id')
ck "按 mime 判型为 image" "image" "$(echo "$IMG" | get 'j.type')"
# `{` 后面带逗号的东西不能直接写进嵌套 `$( )`：bash 会先做花括号展开，
# 把一条 complete 请求拆成三段残缺 JSON（服务端回 400 "Expected ',' or ']'"）。
# 先用 printf 落进变量再引用——展开结果不再参与花括号展开。
CFRAG=$(printf ',"summary":"修复签名校验","artifacts":[{"type":"diff","uri":"%s","name":"fix.patch"}]' "$AURI")
CKFRAG=',"summary":"重复提交","artifacts":[]'
ck "complete 200" "200" "$(code -X POST $B/tasks/$CID/complete -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "$LEASE" "$CFRAG")")"
ck "complete 幂等重放仍 200" "200" "$(code -X POST $B/tasks/$CID/complete -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "$LEASE" "$CKFRAG")")"
ck "已完成后带旧租约重放仍 200（4.3.2 幂等）" "200" "$(code -X POST $B/tasks/$CID/complete -H "$JH" -H "$J" -d "$(lb "$CID" "$RUN" "00000000-0000-0000-0000-000000000000" "$CKFRAG")")"
ck "任务停在待审核" "REVIEW" "$(curl -s $B/tasks/$CID -H "$H" | get 'j.status')"
ck "Run 只有 1 条" "1" "$(curl -s "$B/tasks/$CID/runs" -H "$H" | get 'j.items.length')"
ck "diff 解析出 hunk" "true" "$(curl -s $B/artifacts/$AID/diff -H "$H" | get 'j.files[0].hunks.length>0')"
SIGNED=$(curl -s -X POST $B/artifacts/$AID/sign -H "$H" -H "$J" -d '{}' | get 'j.url')
ck "签名 URL 免 header 取回 raw" "200" "$(code "http://127.0.0.1:${PORT}${SIGNED}")"
ck "签名 URL 一次性（重放失效）" "401" "$(code "http://127.0.0.1:${PORT}${SIGNED}")"
ck "无签名无 header 被拒" "401" "$(code $B/artifacts/$AID/raw)"
ck "非图片产物没有缩略图" "404" "$(code $B/artifacts/$AID/thumbnail -H "$H")"
TSIGNED=$(curl -s -X POST $B/artifacts/$IMGID/sign-thumbnail -H "$H" -H "$J" -d '{}' | get 'j.url')
ck "缩略图签名可免 header 取回" "200" "$(code "http://127.0.0.1:${PORT}${TSIGNED}")"
# kind 在签名载荷里，所以把路径换成另一类资源必然验不过——两类签名互不通用。
CK1=$(printf '%s' "$TSIGNED" | sed 's|/thumbnail?|/raw?|')
CK2=$(printf '%s' "$SIGNED" | sed 's|/raw?|/thumbnail?|')
ck "缩略图签名不能读 raw" "401" "$(code "http://127.0.0.1:${PORT}${CK1}")"
ck "raw 签名不能读缩略图" "401" "$(code "http://127.0.0.1:${PORT}${CK2}")"

echo "== 5 审核与反馈（验收 8/9/10）=="
ck "审核三字段必填" "422" "$(code -X POST $B/tasks/$CID/review -H "$H" -H "$J" -d '{"conclusion":"REJECT"}')"
ck "驳回回待执行" "201" "$(code -X POST $B/tasks/$CID/review -H "$H" -H "$J" -d '{"conclusion":"REJECT","suggestion":"签名校验需覆盖空值","reason":"边界未处理","detail":"补 null 与空串用例","return_to":"READY"}')"
ck "Agent 读到驳回意见" "签名校验需覆盖空值" "$(curl -s "$B/tasks/$CID/review-feedback" -H "$JH" | get 'j.review_feedback[0].suggestion')"
ck "未读通知 >0" "true" "$(curl -s "$B/notifications" -H "$H" | get 'j.unread_count>0?"true":"false"')"
# 再走一遍到 DONE：第 9 段的归档只认已完成任务（4.3 操作表）。领到哪个任务不重要，重要的是链路闭合。
RECLAIM=$(curl -s -X POST $B/tasks/claim -H "$JH" -H "$J" -d '{"capabilities":["language:java"]}')
RID=$(echo "$RECLAIM" | get 'j.task.id'); RRUN=$(echo "$RECLAIM" | get 'j.lease.run_id')
RLEASE=$(echo "$RECLAIM" | get 'j.lease.lease_id')
ck "驳回后能被再次领取" "true" "$(test -n "$RID" && ! printf '%s' "$RID" | grep -qF BAD && echo true || echo false)"
curl -s -o /dev/null -X POST $B/tasks/$RID/complete -H "$JH" -H "$J" -d "$(lb "$RID" "$RRUN" "$RLEASE" ',"summary":"补了空值用例","artifacts":[]')"
ck "通过审核" "201" "$(code -X POST $B/tasks/$RID/review -H "$H" -H "$J" -d '{"conclusion":"APPROVE","suggestion":"可以","reason":"边界已覆盖","detail":"补测通过"}')"
DONE_ID=$RID
ck "审核后进 DONE" "DONE" "$(curl -s $B/tasks/$DONE_ID -H "$H" | get 'j.status')"

echo "== 6 依赖（验收 21/23/29/37）=="
DWN=$(mk "下游任务" 2 '[]'); UPP=$(mk "上游前置" 2 '[]')
curl -s -X POST $B/tasks/$DWN/dependencies -H "$H" -H "$J" -d "{\"depends_on\":\"$UPP\",\"type\":\"blocks\"}" >/dev/null
ready $DWN >/dev/null; ready $UPP >/dev/null
ck "被阻塞任务领不到" "false" "$(curl -s -X POST $B/tasks/claim -H "$JH" -H "$J" -d '{"capabilities":["language:java"]}' | grep -qF "$DWN" && echo true || echo false)"
ck "卡片阻塞角标计数" "1" "$(curl -s $B/tasks/$DWN -H "$H" | get 'j.blocked.count')"
# 环检测另起一对：上面那对已经被 116 的 claim 改成 RUNNING 了，复用它就把断言绑到了前一步的副作用上。
# 能力串用全场独一份的 language:tcl，后续 claim 与第 9 段的 language:objc 都不会牵到它们。
CA=$(mk "环A" 2 '["language:tcl"]'); CB=$(mk "环B" 2 '["language:tcl"]')
curl -s -o /dev/null -X POST $B/tasks/$CA/dependencies -H "$H" -H "$J" -d "{\"depends_on\":\"$CB\",\"type\":\"blocks\"}"
# 依赖体也要先落进变量：`"$( … )"` 里的 `\"` 不算引号，`{"a":1,"b":2}` 会被花括号展开拆成两段 `-d`。
REVERSE=$(printf '{"depends_on":"%s","type":"blocks"}' "$CA")
SELF=$(printf '{"depends_on":"%s","type":"blocks"}' "$CA")
ck "循环依赖 409" "409" "$(code -X POST $B/tasks/$CB/dependencies -H "$H" -H "$J" -d "$REVERSE")"
ck "自依赖 409" "409" "$(code -X POST $B/tasks/$CA/dependencies -H "$H" -H "$J" -d "$SELF")"
UP=$(mk "未完成前置" 2 '["language:carbon"]'); DOWN=$(mk "被挡下游" 2 '["language:carbon"]')
curl -s -X POST $B/tasks/$DOWN/dependencies -H "$H" -H "$J" -d "{\"depends_on\":\"$UP\",\"type\":\"blocks\"}" >/dev/null
ready $UP >/dev/null
ck "归档未完成前置被拒" "409" "$(code -X POST $B/tasks/$UP/archive -H "$H" -H "$J" -d '{}')"

echo "== 7 强制停止（验收 34）=="
# 停止要的是一个**此刻确实在 RUNNING** 的任务，不能指望队列里还剩什么：
# 能力串用全场独一份的 language:fsharp，请求里显式声明它会覆盖 Token 能力（20.5）。
SN=$(mk "停止用任务" 2 '["language:fsharp"]'); ready $SN >/dev/null
SC=$(curl -s -X POST $B/tasks/claim -H "$JH" -H "$J" -d '{"capabilities":["language:fsharp"]}')
SRUN=$(echo "$SC" | get 'j.lease.run_id'); SLEASE=$(echo "$SC" | get 'j.lease.lease_id')
SID=$(echo "$SC" | get 'j.task.id')
WRITEBACK=$(lb "$SID" "$SRUN" "$SLEASE" ',"progress":1,"message":"x"')
# 还在执行中，所以这一条才是 4.3.2 的 410 现场（第 4 段那条重放已经是待审核，按幂等返回 200）。
ck "执行中带错租约回写 410" "410" "$(code -X POST $B/tasks/$SID/progress -H "$JH" -H "$J" -d "$(lb "$SID" "$SRUN" "00000000-0000-0000-0000-000000000000" ',"progress":99,"message":"x"')")"
ck "410 那次回写没改进度" "true" "$(curl -s $B/tasks/$SID -H "$H" | get 'String(j.progress!==99)')"
ck "停止 RUNNING" "201" "$(code -X POST $B/tasks/$SID/stop -H "$H" -H "$J" -d '{}')"
ck "停止后回写 LEASE_REVOKED" "LEASE_REVOKED" "$(curl -s -X POST $B/tasks/$SID/progress -H "$JH" -H "$J" -d "$WRITEBACK" | get 'j.error.code')"
ck "停止后落异常列" "FAILED" "$(curl -s $B/tasks/$SID -H "$H" | get 'j.status')"
ck "stop_reason 记 user_stop" "user_stop" "$(curl -s $B/tasks/$SID -H "$H" | get 'j.stop_reason||""')"
ck "非 RUNNING 再停止 409" "409" "$(code -X POST $B/tasks/$SID/stop -H "$H" -H "$J" -d '{}')"

echo "== 8 置顶优先与归档（验收 24/27/28）=="
PIN=$(mk "置顶低分" 3); UNP=$(mk "不置顶高分" 0)
ready $PIN >/dev/null; ready $UNP >/dev/null
curl -s -X POST $B/tasks/$PIN/pin -H "$H" -H "$J" >/dev/null
ORDER=""
for _ in 1 2 3 4 5 6; do
  CID3=$(curl -s -X POST $B/tasks/claim -H "$GH" -H "$J" -d '{"capabilities":["language:java","tool:maven"]}' | get 'j.task?j.task.id:""')
  [ -z "$CID3" ] && break
  if [ "$CID3" = "$PIN" ]; then ORDER="${ORDER}P"; elif [ "$CID3" = "$UNP" ]; then ORDER="${ORDER}U"; fi
done
ck "置顶先于优先级被领到" "PU" "$ORDER"

BL=$(mk "未完成就归档" 2 '["language:carbon"]')
BATCH=$(curl -s -X POST $B/tasks/batch/archive -H "$H" -H "$J" -d "{\"ids\":[\"$DONE_ID\",\"$BL\"]}")
ck "批量归档逐条判定" "1" "$(echo "$BATCH" | get 'j.succeeded.length')"
ck "非 DONE 被跳过并给原因" "true" "$(echo "$BATCH" | get 'j.skipped.length===1&&/ILLEGAL_TRANSITION/.test(j.skipped[0].reason)')"
ck "归档后不在默认看板" "false" "$(curl -s $B/board -H "$H" | grep -qF "$DONE_ID" && echo true || echo false)"
ck "已归档列表查得到" "1" "$(curl -s "$B/tasks?archived=true&page=1" -H "$H" | argget 'j.items.filter(t=>t.id===process.argv[1]).length' "$DONE_ID")"
ck "恢复后回到默认看板" "true" "$(curl -s -X POST $B/tasks/$DONE_ID/restore -H "$H" -H "$J" >/dev/null; curl -s $B/board -H "$H" | grep -qF "$DONE_ID" && echo true || echo false)"
ck "自动归档天数改得动" "5" "$(curl -s -X PATCH $B/settings -H "$H" -H "$J" -d '{"auto_archive_days":5}' | get 'j.auto_archive_days')"
ck "日志保留天数改得动" "7" "$(curl -s -X PATCH $B/settings -H "$H" -H "$J" -d '{"log_retention_days":7}' | get 'j.log_retention_days')"

echo "== 9 删除级联与契约校验（验收 38/43）=="
# 「运行中不许删」要一个此刻确实在 RUNNING 的任务，所以另造一个：它要的能力全场唯一，
# 而请求里显式声明的能力会覆盖 Token 能力（20.5）——claim 必然命中它，也不会顺手牵走别的 READY 任务。
RND=$(mk "运行中不许删" 1 '["language:objc"]'); ready $RND >/dev/null
curl -s -X POST $B/tasks/claim -H "$JH" -H "$J" -d '{"capabilities":["language:objc"]}' >/dev/null
ck "RUNNING 不许删除" "409" "$(code -X DELETE "$B/tasks/$RND" -H "$H")"
ck "删除带 Run 与产物的任务" "true" "$(curl -s -X DELETE "$B/tasks/$CID" -H "$H" | get 'j.deleted_runs>0')"
ck "产物行随任务一起消失" "404" "$(code $B/artifacts/$AID -H "$H")"
CID4=$(mk "枚举任务" 2 '["language:carbon"]')
ck "非法转移目标 422" "422" "$(code -X POST $B/tasks/$CID4/transition -H "$H" -H "$J" -d '{"to":"DONE-ish"}')"
ck "非法优先级 422" "422" "$(code -X POST $B/tasks -H "$H" -H "$J" -d '{"title":"越界","priority":9,"custom_fields":{"severity":"低"}}')"
ck "能力串缺命名空间 422" "422" "$(code -X POST $B/tasks -H "$H" -H "$J" -d '{"title":"能力串没命名空间","required_capabilities":["java"],"custom_fields":{"severity":"低"}}')"
ck "列表 sort 白名单外 422" "422" "$(code "$B/tasks?sort=agent&order=desc" -H "$H")"

echo "== 10 平台接口（收尾，会吊销 Token）=="
ck "设置读取" "200" "$(code $B/settings -H "$H")"
ck "未知设置键 422" "422" "$(code -X PATCH $B/settings -H "$H" -H "$J" -d '{"nope":1}')"
ck "字段定义 PATCH 只改 label" "严重度v2" "$(FID=$(curl -s $B/field-defs -H "$H" | get 'j.items[0].id'); curl -s -X PATCH $B/field-defs/$FID -H "$H" -H "$J" -d '{"label":"严重度v2"}' | get 'j.label')"
ck "PATCH 后 required 未被重置" "true" "$(curl -s $B/field-defs -H "$H" | get 'j.items[0].required')"
ck "PATCH 改 key 被拒" "422" "$(FID=$(curl -s $B/field-defs -H "$H" | get 'j.items[0].id'); code -X PATCH $B/field-defs/$FID -H "$H" -H "$J" -d '{"key":"hacked"}')"
ck "模板创建" "缺陷模板" "$(curl -s -X POST $B/templates -H "$H" -H "$J" -d '{"name":"缺陷模板","preset":{"type":"需求","priority":1}}' | get 'j.name')"
ck "审计只读列表倒序" "true" "$(curl -s "$B/audit?page=1" -H "$H" | get 'j.items.length>0?"true":"false"')"
ck "备份名单拒绝路径穿越" "400" "$(code -X POST "$B/settings/backups/..%2F..%2Fetc%2Fpasswd/restore" -H "$H" -H "$J" -d '{}')"
ck "Token 吊销后 401" "401" "$(code -X DELETE $B/tokens/$JID -H "$H" -H "$J" >/dev/null; code $B/tasks/ready -H "$JH")"

echo "--- 主链路探针：pass=$pass fail=$fail"
