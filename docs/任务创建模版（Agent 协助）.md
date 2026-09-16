# 任务创建模版（供 Agent 协助填写与创建）

> 用途：把本文件发给任意 AI 助手（Cursor / Claude / WorkBuddy 等），说「按这个模版帮我建任务」，
> Agent 会按字段约束填好 JSON，并可在你授权后代为调用 REST 创建。
> 字段约束的代码依据：`apps/api/src/contract/schemas.ts`（taskCreateSchema）、`apps/api/src/contract/enums.ts`。

---

## 1. 使用方式

**方式 A：Agent 代创建（推荐）**

1. 把本文件内容发给 AI 助手，附上任务需求的一句话描述；
2. Agent 按下方「字段约束」填出 JSON；
3. 你确认后，Agent 执行创建（需 UI Token，见第 4 节）。

**方式 B：人工创建**

Agent 填好 JSON 后，你直接在看板 UI 新建任务时照抄字段即可。

> ⚠️ 权限说明：创建任务是 **UI 作用域**接口——必须用 `ATB_UI_TOKEN` 调用；
> Agent Token（MCP / REST 认领用的）**不能**创建任务（`auth.guard.ts`：跨组凭证直接 403）。
> Agent 代创建时应向你要 UI Token，用完不落盘、不写入对话记录为宜。

---

## 2. 任务模版（JSON）

```jsonc
{
  "title": "【必填】任务标题，≤200 字符，一句话说清做什么",
  "type": "需求",                    // 必填，≤16 字符；默认五类：需求/缺陷/子任务/巡检/重构，也可自定义
  "priority": 2,                     // 0 紧急 / 1 高 / 2 中 / 3 低，缺省 3
  "description": "【强烈建议】给 Agent 的执行说明：目标、范围、验收标准、涉及文件/模块。",
  "tags": ["前端"],                  // 最多 10 个，每个 ≤16 字符，自动去重
  "required_capabilities": [         // 最多 20 个；格式 namespace:value（namespace 小写字母开头）
    "repo:agent-task-board"          // 约定命名空间：language / framework / repo / tool
  ],
  "custom_fields": {},               // 与「字段定义」配套的自定义字段，无则空对象
  "due_at": "2026-09-30",            // 可选；YYYY-MM-DD 或 ISO 8601
  "depends_on": [],                  // 可选；依赖任务的 id 列表，最多 50 个
  "dependency_type": "blocks",       // blocks（被依赖阻塞）/ relates（仅关联），缺省 blocks
  "pinned": false                    // 是否置顶
}
```

**模版精简版（最小可创建）**：

```json
{
  "title": "一句话标题",
  "type": "需求",
  "description": "执行说明与验收标准"
}
```

---

## 3. 字段约束速查（Agent 填写时逐条对照）

| 字段 | 必填 | 约束 | 越界后果 |
| --- | --- | --- | --- |
| `title` | ✅ | 1–200 字符，去首尾空白 | 400 拒绝 |
| `type` | ✅ | 1–16 字符；建议用默认五类：需求 / 缺陷 / 子任务 / 巡检 / 重构 | 400 拒绝 |
| `priority` | — | 整数 0–3（0 紧急 / 1 高 / 2 中 / 3 低），缺省 3 | 400 拒绝 |
| `description` | — | ≤20000 字符 | 400 拒绝 |
| `tags` | — | 数组 ≤10 项，每项 1–16 字符，自动去重 | 400 拒绝 |
| `required_capabilities` | — | 数组 ≤20 项，每项匹配 `^[a-z][a-z0-9_-]*:[^\s]+$`、≤64 字符 | 400 拒绝 |
| `custom_fields` | — | 任意键值对象（与字段定义联动） | — |
| `due_at` | — | `YYYY-MM-DD` 或 ISO 8601（含/不含 Z 均可，服务端归一） | 400 拒绝 |
| `depends_on` | — | 任务 id 数组 ≤50 项 | 400 拒绝 |
| `dependency_type` | — | `blocks` \| `relates`，缺省 `blocks` | 400 拒绝 |
| `pinned` | — | 布尔，缺省 false | — |

**创建后行为**：新任务一律进入 **BACKLOG（需求池）**；`status` 不是可写字段。
状态推进由流转接口 / Agent 认领事务产生，最终完成必须经人工审核（REVIEW → DONE）。

**Agent 填写守则**：

1. `description` 是给执行 Agent 的作业说明书——写清「做什么、不做什么、验收标准」；
   模糊的任务会被审核驳回，浪费一轮执行。
2. `priority` 慎用 0（紧急）：紧急任务会抢占认领顺序，仅用于真实阻塞。
3. `required_capabilities` 只在需要精确匹配执行环境时填（如指定 repo）；不填则所有 Agent 均可认领。
4. 有前置任务先建前置、后建依赖方，`depends_on` 填**前置任务**的 id。
5. 标题同一批内不要重复；批量创建时按依赖拓扑排序提交。

---

## 4. 创建请求（方式 A 由 Agent 执行）

```bash
curl -s -X POST http://127.0.0.1:7788/api/v1/tasks \
  -H "Authorization: Bearer $ATB_UI_TOKEN" \
  -H "Content-Type: application/json" \
  -d @task.json
```

- 端口默认 **7788**（`ATB_PORT` / `config.json` 可改），服务只绑 `127.0.0.1`。
- `ATB_UI_TOKEN` 即桌面端使用的 UI 凭证；响应为创建后的任务对象（含 `id`）。
- 批量创建：循环调用即可（同依赖的任务先建前置）；批量状态流转另有 `POST /api/v1/tasks/batch/transition`。

**Agent 代创建时的标准话术**（可直接复制给 AI 助手）：

> 请阅读《任务创建模版》文档，按其中的字段约束与填写守则，把我下面的需求整理成任务 JSON，
> 给我确认后用 UI Token 调 `POST /api/v1/tasks` 创建，并把返回的任务 id 告诉我。
> 需求：<在这里写你的需求描述>

---

## 5. 示例：带依赖的一组任务

```bash
# 先建前置：数据库迁移脚本
curl -s -X POST http://127.0.0.1:7788/api/v1/tasks \
  -H "Authorization: Bearer $ATB_UI_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "title": "编写 v0.2 用户表迁移脚本",
    "type": "子任务",
    "priority": 1,
    "description": "产出 apps/api/prisma/migrations/000X 迁移文件；验收：空库与既有库均可执行。",
    "tags": ["数据库"],
    "required_capabilities": ["repo:agent-task-board"]
  }'
# → 返回 {"id": "T-xxxx", ...}，记下 id

# 再建依赖方：depends_on 填前置任务 id
curl -s -X POST http://127.0.0.1:7788/api/v1/tasks \
  -H "Authorization: Bearer $ATB_UI_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "title": "用户表接入看板列表接口",
    "type": "需求",
    "priority": 2,
    "description": "在 board/list 查询中返回用户新列；验收：vitest 覆盖 + web 类型检查通过。",
    "depends_on": ["T-xxxx"],
    "dependency_type": "blocks"
  }'
```

前置未完成时，依赖方在看板显示为「被阻塞」，不会被 Agent 认领（`list_ready_tasks` 服务端过滤）。
