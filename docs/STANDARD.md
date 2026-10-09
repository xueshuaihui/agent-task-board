# 贾维斯工作台（Jarvis Workbench）唯一标准文档

**版本**: v0.0.4-beta.9  
**更新日期**: 2026-10-09  
**状态**: 主分支稳定，待出 beta.10

---

## 目录

1. [产品定位](#1-产品定位)
2. [核心功能](#2-核心功能)
3. [技术架构](#3-技术架构)
4. [数据模型](#4-数据模型)
5. [任务状态机](#5-任务状态机)
6. [审核机制](#6-审核机制)
7. [MCP 工具集](#7-mcp-工具集)
8. [REST API](#8-rest-api)
9. [前端特性](#9-前端特性)
10. [部署与发布](#10-部署与发布)

---

## 1. 产品定位

**贾维斯工作台**是一个桌面端任务看板应用，作为 Agent 的任务来源与结果审核中心。

### 1.1 交付形态

- **Tauri 桌面应用**：原生主窗口 + 托盘图标
- **常驻本地服务**：`127.0.0.1:7788`，提供 Agent 侧的 REST / MCP / WebSocket 端点
- **数据库**：SQLite（本地文件存储）

### 1.2 核心价值

1. **任务可视化**：看板视图管理任务流转
2. **Agent 自治**：Agent 通过 MCP/REST 自动认领任务并执行
3. **人工审核**：默认强制人工审核，支持"免审核"直通
4. **依赖管理**：DAG 依赖图，Agent 严格遵守依赖顺序
5. **零 Agent 管理**：平台不管理 Agent，只提供接入接口

### 1.3 非目标

- 不主动触发 Agent
- 不管理 Agent 生命周期
- 不做多用户与权限（单用户本地使用）
- 不做外部任务同步

---

## 2. 核心功能

### 2.1 任务管理

- **创建方式**：手动创建、模板创建、Agent 拆解创建
- **任务类型**：需求、缺陷、子任务、巡检、重构（可自定义）
- **优先级**：0（紧急）、1（高）、2（中）、3（低）
- **自定义字段**：支持文本、数字、日期、单选、多选等类型
- **技能绑定**：任务可绑定技能，指导 Agent 执行

### 2.2 任务依赖

- **阻塞依赖（blocks）**：前置任务完成后，后置任务才可领取
- **关联依赖（relates）**：仅关联，不影响领取
- **DAG 视图**：可视化展示任务依赖关系
- **层级限制**：最多两层（需求 → 子任务）

### 2.3 审核机制

- **人工审核（human）**：默认模式，任务完成后进入 REVIEW 状态，需人工填写审核意见
- **免审核（none）**：任务完成后直接进入 DONE 状态
- **审核意见**：包含建议、原因、详情，Agent 下次可读取

> **重要裁定（2026-10-09）**："Agent 当审核方"整链已移除，只剩 human/none 两种模式。

### 2.4 归档能力

- **普通任务**：必须 DONE 状态才能归档
- **需求类型**：任意状态可归档，但需满足：
  - 所有子任务都已完成或已归档
  - 不是其他未完成任务的依赖前置
- **批量归档**：支持多选批量归档
- **归档筛选**：列表页支持查看已归档任务

### 2.5 导入导出

- **JSON 导出**：完整任务数据（含依赖、自定义字段、产物）
- **CSV 导出**：扁平化任务列表
- **JSON 导入**：从备份恢复任务
- **ID 冲突处理**：导入时检测 ID 冲突，提供跳过/覆盖选项

### 2.6 技能系统

- **内置技能**：随包发布的默认技能（只读）
- **自定义技能**：用户创建的技能，可编辑、发布版本
- **技能分类**：两级树状分类（一级 7 类，二级 16 叶子节点）
- **技能搜索**：按名称、描述、标签、分类搜索
- **MCP 依赖声明**：技能可声明依赖的第三方 MCP 服务器

---

## 3. 技术架构

### 3.1 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Tauri 2.x |
| 前端框架 | React 18 + Vite |
| UI 组件 | Ant Design 5.x |
| 状态管理 | Zustand |
| 后端框架 | NestJS 10.x |
| ORM | Prisma 5.x |
| 数据库 | SQLite (better-sqlite3) |
| MCP SDK | @modelcontextprotocol/sdk |

### 3.2 端口与服务

- **7788**：Agent 专用端口
  - `GET/POST /api/v1/*`：REST API
  - `/mcp`：MCP Streamable HTTP 传输
  - `/ws`：WebSocket（实时通知）

### 3.3 目录结构

```
apps/
├── api/              # 后端 NestJS 服务
│   ├── src/
│   │   ├── agent/    # Agent 工具与服务（租约、认领、回写）
│   │   ├── mcp/      # MCP 服务器实现
│   │   ├── tasks/    # 任务 CRUD 与状态机
│   │   ├── skills/   # 技能管理
│   │   ├── groups/   # 分组管理
│   │   ├── creation/ # 任务创建与会话
│   │   └── prisma/   # 数据模型与迁移
│   └── prisma/migrations/  # 数据库迁移 SQL
├── web/              # 前端 React 应用
│   └── src/
│       ├── features/ # 功能模块（board, task-list, settings 等）
│       ├── api/      # API 客户端与错误处理
│       └── lib/      # 工具函数
└── desktop/          # Tauri 桌面壳
    └── src-tauri/    # Rust 原生层
```

### 3.4 认证与授权

- **Token 类型**：
  - `user_*`：UI 会话 Token，拥有全部读写权限
  - `agent_*`：Agent 凭证 Token，仅限 MCP 工具调用
- **鉴权方式**：`Authorization: Bearer <token>`
- **CORS**：Origin 白名单（仅允许 `tauri://localhost`）

---

## 4. 数据模型

### 4.1 核心表

#### Task（任务）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 任务 ID（T-xxxx） |
| type | TEXT | 任务类型（需求/缺陷/子任务/巡检/重构） |
| title | TEXT | 标题 |
| description | TEXT | 描述 |
| status | TEXT | 状态（见状态机） |
| priority | INT | 优先级（0-3） |
| group_id | TEXT FK | 归属分组 |
| parent_task_id | TEXT FK | 父需求 ID |
| tags | TEXT JSON | 标签数组 |
| skills | TEXT JSON | 技能绑定 `[{skill_id, version}]` |
| custom_fields | TEXT JSON | 自定义字段 |
| review_mode | TEXT | 审核方式（human/none） |
| archived_at | TEXT | 归档时间戳 |
| current_run_id | TEXT | 当前执行 Run ID |
| lease_id | TEXT | 当前租约 ID |
| origin_type | TEXT | 来源类型（user/agent） |
| origin_agent | TEXT | 来源 Agent 名称 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

#### TaskRun（执行记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | Run ID |
| task_id | TEXT FK | 任务 ID |
| status | TEXT | 状态（RUNNING/COMPLETED/FAILED/ABANDONED） |
| lease_id | TEXT UUID | 租约 ID |
| lease_expires_at | TEXT | 租约过期时间 |
| started_at | TEXT | 开始时间 |
| completed_at | TEXT | 完成时间 |

#### TaskDependency（任务依赖）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 ID |
| task_id | TEXT FK | 后置任务 ID |
| depends_on | TEXT FK | 前置任务 ID |
| type | TEXT | 依赖类型（blocks/relates） |

#### Review（审核记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 审核 ID |
| task_id | TEXT FK | 任务 ID |
| run_id | TEXT FK | 执行记录 ID |
| reviewer_token_id | TEXT | 审核者 Token ID |
| conclusion | TEXT | 审核结论（pass/reject） |
| feedback | TEXT | 审核意见 |
| created_at | TEXT | 审核时间 |

#### Skill（技能）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 技能 ID（skl_xxx） |
| name | TEXT | 技能名称 |
| category | TEXT | 分类（两级路径） |
| content | TEXT JSON | 技能内容块模型 |
| status | TEXT | 状态（draft/published/archived） |
| source | TEXT | 来源（builtin/custom） |
| current_version | TEXT | 当前版本号（semver） |

#### Group（分组）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | 分组 ID |
| name | TEXT | 分组名称 |
| status | TEXT | 状态（ACTIVE/ARCHIVED） |
| is_default | INT | 是否默认分组 |
| archived_at | TEXT | 归档时间戳 |

### 4.2 索引策略

- `tasks.status`：状态过滤
- `tasks.group_id`：分组过滤
- `tasks.parent_task_id`：子任务查询
- `tasks.archived_at`：归档筛选
- `task_dependencies.task_id`：依赖查询

---

## 5. 任务状态机

### 5.1 状态定义

| 状态 | 英文名 | 说明 |
|------|--------|------|
| 待办 | BACKLOG | 初始状态，未进入就绪队列 |
| 就绪 | READY | 可被 Agent 认领 |
| 执行中 | RUNNING | 已被认领，持有租约 |
| 待审核 | REVIEW | 执行完成，等待人工审核 |
| 已完成 | DONE | 审核通过或免审核直通 |
| 失败 | FAILED | 执行失败或被强制停止 |
| 阻塞 | BLOCKED | 人工介入，等待处理 |

### 5.2 状态流转

```
BACKLOG → READY（手动移动或依赖解锁）
READY → RUNNING（Agent claim_next_task）
RUNNING → REVIEW（complete_task，review_mode=human）
RUNNING → DONE（complete_task，review_mode=none）
RUNNING → FAILED（fail_task）
RUNNING → BLOCKED（block_task）
REVIEW → READY（审核驳回）
REVIEW → DONE（审核通过）
BLOCKED → READY（人工处理后转回）
```

### 5.3 不可编辑状态

- **RUNNING**：需持当前租约三元组（task_id + run_id + lease_id）才可修改
- **BACKLOG/READY**：免租约可修改
- **BLOCKED/REVIEW/DONE/FAILED**：不可编辑，需先转换状态

---

## 6. 审核机制

### 6.1 审核模式

| 模式 | 值 | 说明 |
|------|-----|------|
| 人工审核 | human | 任务完成后进入 REVIEW，需人工填写审核意见 |
| 免审核 | none | 任务完成后直接进入 DONE |

### 6.2 审核流程（human 模式）

1. Agent 调用 `complete_task` 上报完成
2. 任务状态转为 REVIEW
3. 用户在 UI 填写审核表单：
   - 结论：通过 / 驳回
   - 反馈：建议、原因、详情
4. 审核通过 → DONE；审核驳回 → READY（附带反馈意见）
5. Agent 下次认领时可调用 `get_review_feedback` 读取意见

### 6.3 全局默认设置

- 设置键：`default_review_mode`
- 取值：human（默认）/ none
- Agent 创建的任务继承此设置，不可自行豁免

---

## 7. MCP 工具集

### 7.1 服务器信息

- **名称**：`jarvis-workbench`
- **唤醒词**：「贾维斯」
- **退出指令**：「退出贾维斯」
- **传输协议**：Streamable HTTP

### 7.2 基础工具（12 章）

| 工具名 | 说明 | 入参 |
|--------|------|------|
| `list_ready_tasks` | 查询可领取任务 | limit, types, capabilities |
| `claim_next_task` | 原子认领下一个任务 | types, capabilities |
| `get_task` | 获取任务详情 | task_id |
| `update_progress` | 更新进度 | task_id, run_id, lease_id, step, total |
| `append_log` | 追加日志 | task_id, run_id, lease_id, lines |
| `complete_task` | 完成任务 | task_id, run_id, lease_id, artifacts |
| `fail_task` | 失败上报 | task_id, run_id, lease_id, reason |
| `heartbeat` | 续租 | task_id, run_id, lease_id |
| `get_review_feedback` | 获取审核意见 | task_id, limit |
| `block_task` | 上报人工阻塞 | task_id, run_id, lease_id, reason |
| `wait_for_resume` | 等待人工处理完成 | task_id, timeout_seconds |
| `update_task` | 全字段 PATCH 编辑 | task_id, [字段...] |

### 7.3 技能工具

| 工具名 | 说明 |
|--------|------|
| `list_skills` | 列出技能（可按分类/状态/标签过滤） |
| `get_skill` | 获取技能详情 |
| `search_skills` | 按关键字搜索技能 |
| `update_skill` | 全字段 PATCH 编辑技能 |

### 7.4 拆解工具（board.*）

| 工具名 | 说明 |
|--------|------|
| `board.begin_breakdown` | 发起需求拆解会话 |
| `board.report_progress` | 上报拆解进度 |
| `board.report_task_draft` | 上报单个任务草案 |
| `board.finish_breakdown` | 完成拆解，依赖校验 |
| `board.cancel_breakdown` | 取消拆解会话 |

### 7.5 创建工具（board.*）

| 工具名 | 说明 |
|--------|------|
| `board.create_task` | 会话创建单个任务（direct/silent/light 三模式） |
| `board.create_tasks_batch` | 批量创建任务（≤20 条） |
| `board.get_creation_status` | 轮询创建请求结果 |
| `board.wait_for_confirmation` | 阻塞等待轻确认决策 |

### 7.6 策略工具

| 工具名 | 说明 |
|--------|------|
| `check_mcp_policy` | 调用第三方 MCP 前的策略裁决 |
| `report_mcp_call` | 上报 MCP 调用结果 |

### 7.7 词表工具

| 工具名 | 说明 |
|--------|------|
| `get_vocabulary` | 获取服务端当前全部词表口径（无入参） |

---

## 8. REST API

### 8.1 任务端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/tasks` | 任务列表（支持分页、筛选） |
| POST | `/api/v1/tasks` | 创建任务 |
| GET | `/api/v1/tasks/:id` | 任务详情 |
| PATCH | `/api/v1/tasks/:id` | 更新任务 |
| DELETE | `/api/v1/tasks/:id` | 删除任务 |
| POST | `/api/v1/tasks/:id/archive` | 归档任务 |
| POST | `/api/v1/tasks/:id/restore` | 恢复归档 |
| POST | `/api/v1/tasks/:id/pin` | 置顶任务 |
| DELETE | `/api/v1/tasks/:id/pin` | 取消置顶 |
| POST | `/api/v1/tasks/batch/transition` | 批量状态转换 |
| POST | `/api/v1/tasks/batch/archive` | 批量归档 |
| POST | `/api/v1/tasks/batch/tags` | 批量打标签 |

### 8.2 依赖端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/tasks/:id/dependencies` | 添加依赖 |
| DELETE | `/api/v1/tasks/:id/dependencies/:depId` | 删除依赖 |

### 8.3 分组端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/groups` | 分组列表 |
| POST | `/api/v1/groups` | 创建分组 |
| PATCH | `/api/v1/groups/:id` | 更新分组 |
| DELETE | `/api/v1/groups/:id` | 删除分组 |

### 8.4 技能端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/skills` | 技能列表 |
| POST | `/api/v1/skills` | 创建技能 |
| GET | `/api/v1/skills/:id` | 技能详情 |
| PATCH | `/api/v1/skills/:id` | 更新技能 |
| DELETE | `/api/v1/skills/:id` | 删除技能 |
| POST | `/api/v1/skills/:id/versions` | 发布新版本 |

### 8.5 设置端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/settings` | 获取全部设置 |
| GET | `/api/v1/settings/:key` | 获取单个设置 |
| PUT | `/api/v1/settings/:key` | 更新设置 |

### 8.6 导入导出端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/data/export` | 导出数据（JSON/CSV） |
| POST | `/api/v1/data/import` | 导入数据（JSON） |

---

## 9. 前端特性

### 9.1 看板视图

- **列布局**：BACKLOG / READY / RUNNING / REVIEW / DONE / FAILED / BLOCKED
- **拖拽排序**：支持列内拖拽调整顺序
- **分组筛选**：按分组过滤卡片
- **需求过滤**：只看某需求下的子任务
- **置顶标记**：pinned 任务始终在列顶部

### 9.2 任务列表

- **表格视图**：支持排序、筛选、分页
- **批量操作**：批量归档、批量打标签、批量状态转换
- **归档筛选**：支持查看已归档任务
- **列自定义**：显示/隐藏列，调整列宽

### 9.3 任务详情抽屉

- **概览 Tab**：基本信息、自定义字段、父子任务
- **依赖 Tab**：前置/后置依赖列表与 DAG 图
- **执行记录 Tab**：历史 Run 列表与日志
- **审核记录 Tab**：审核意见与反馈
- **产物 Tab**：执行产物预览（图片、diff）

### 9.4 设置页面

- **通用设置**：默认审核模式、创建模式、语言
- **Token 管理**：生成/撤销 UI Token 与 Agent Token
- **MCP 配置**：唤醒模式（单次/连续）、超时时间
- **字段定义**：自定义字段的增删改查
- **技能管理**：技能的创建、编辑、发布、分类
- **数据管理**：导入导出、备份恢复

### 9.5 响应式设计

- **最小窗口宽度**：960px
- **三档断点**：窄（<1200px）、中（1200-1600px）、宽（>1600px）
- **窗口状态记忆**：记住上次关闭时的窗口尺寸与位置

---

## 10. 部署与发布

### 10.1 开发环境

```bash
# 安装依赖
npm install

# 启动开发服务
npm run dev        # 同时启动 API 和 Web
npm run dev:api    # 只启动 API（端口 7788）
npm run dev:web    # 只启动 Web（Vite 热更新）

# 数据库迁移
npm run migrate:dev  # 开发环境迁移

# 类型检查
npm run typecheck

# 运行测试
npm test
```

### 10.2 构建与打包

```bash
# 构建生产版本
npm run build

# 打包桌面应用
npm run tauri build

# 产物位置
# macOS: src-tauri/target/release/bundle/dmg/Jarvis.Workbench_*.dmg
# Windows: src-tauri/target/release/bundle/nsis/Jarvis.Workbench_*_setup.exe
```

### 10.3 发版流程

1. **代码冻结**：确保 main 分支绿色（CI 全绿）
2. **打 Tag**：`git tag v0.0.4-beta.10 && git push origin v0.0.4-beta.10`
3. **CI 自动构建**：GitHub Actions 自动构建三平台安装包
4. **发布 Release**：上传 DMG/EXE 到 GitHub Releases
5. **真机验证**：按 `docs/v0.0.4/beta真机验证清单.md` 逐项验收
6. **发布公告**：更新 `docs/发版记录.md`

### 10.4 数据库迁移

```bash
# 应用迁移（生产环境）
npx prisma migrate deploy

# 迁移水位记录在 _atb_migrations 表
# 迁移文件位于 apps/api/prisma/migrations/
```

### 10.5 当前版本水位

- **最新 Tag**：v0.0.4-beta.9（commit: d3f32c0）
- **迁移版本**：0023（拆掉 Agent 审核链）
- **API 代码行数**：68 文件 / 765 行
- **Web 代码行数**：30 文件 / 275 行

---

## 11. 统一错误码

|code|HTTP|触发|调用方|
|---|---|---|---|
|`UNAUTHORIZED`|401|无凭证 / Token 已吊销 / UI Token 缺失|全部|
|`FORBIDDEN`|403|凭证组不匹配（Agent Token 调用户接口，或反之，见 13 章「跨组拒绝」）|全部|
|`VALIDATION_FAILED`|422|必填缺失、枚举越界、自定义字段校验失败（`details[]` 逐字段）|全部|
|`NOT_FOUND`|404|任务／产物／模板／字段定义不存在或已归档过滤掉|全部|
|`ILLEGAL_TRANSITION`|409|不符合 4\.5 拖拽矩阵的流转|UI|
|`TASK_NOT_RUNNING`|409|对非 `RUNNING` 任务调用 `stop`|UI|
|`TASK_RUNNING`|409|删除／归档 `RUNNING` 任务，或 UI 侧 `PATCH /tasks/{id}` 试图编辑执行中的任务（v0.0.4 §16.1 起 Agent 的 `update_task` 不在这一条：持当前租约即放行，见下）|UI|
|`TASK_NOT_EDITABLE`|409|v0.0.4 §16.1 MCP `update_task`（全字段 PATCH）的第三支守卫：任务停在 `BLOCKED`／`REVIEW`／`DONE`／`FAILED` 这些编辑窗口之外的状态。`message` 与 `details[]` 必须指名该走的链路（BLOCKED＝人工处理后转 READY 重认领、REVIEW＝审核表单、DONE＝终态需新建任务、FAILED＝转回 READY 重认领），`context` 带 `task_id/status/route`|Agent|
|`ARCHIVE_BLOCKED_BY_DEPENDENCY`|409|归档仍是未完成任务的前置（4\.3\.1 规则 3）|UI / 定时任务|
|`DEPENDENCY_CYCLE`|409|新增依赖成环（9\.3）|UI|
|`LEASE_EXPIRED`|410|租约已过期（4\.3\.2）|Agent|
|`LEASE_REVOKED`|410|租约被用户强制停止吊销（4\.3\.2）|Agent|
|`TASK_GONE`|409|任务已删除|Agent|
|`ARTIFACT_TOO_LARGE`|413|超过 `artifact_max_mb`|Agent|
|`ARTIFACT_LOST`|404|数据库有记录、磁盘文件缺失|UI|
|`IMPORT_ID_CONFLICT`|409|导入 ID 冲突且未指定策略（6\.12\.2）|UI|
|`FIELD_IN_USE`|409|删除被任务引用的字段定义，`details.task_count` 给出引用数（13 章字段接口）|UI|
|`INVALID_BACKUP_NAME`|400|恢复入参不符合 `^atb-\d{8}-\d{6}\.db$`，或含路径分隔符（组装路径前的白名单校验，13 章备份接口）|UI|
|`BACKUP_NOT_FOUND`|404|文件名合法但磁盘上不存在——备份列表来自磁盘扫描，两次请求之间可能被人手动删除|UI|
|`INVALID_PARAM`|422|入参**形状**不合（枚举越界、id 含非法字符、WS 用查询参数带凭证），区别于 `VALIDATION_FAILED` 的逐字段业务校验|全部|
|`SKILL_BOUND`|409|8 章：删除仍被任务绑定的技能，`context.bound_count` 给出绑定任务数|UI|
|`SKILL_ID_CONFLICT`|409|§9\.8\.4 导入撞同 ID 且未指定策略，回「覆盖更新／跳过」两选|UI|
|`SKILL_READONLY`|403|§9\.1 内置默认技能拒改、拒删、拒发版本|UI / Agent|
|`SKILL_REF_SELF`|400|§9 技能子引用 `skillRef` 指回自己（入参本身非法）|UI|
|`SKILL_REF_CYCLE`|409|§9 技能引用链与库内既有图形成环|UI|
|`GROUP_LIMIT_REACHED`|409|§5\.5 活跃分组数达到上限 50|UI / Agent|
|`GROUP_DEFAULT_PROTECTED`|409|§5\.2／§5\.5／§5\.6 预置「默认」分组不可删除，也不可归档|UI / Agent|
|`GROUP_NOT_ALL_DONE`|409|§5\.6 归档前置校验未过：组内还有未完成／未归档任务，`context.remaining` 带剩余数|UI / Agent|
|`GROUP_ARCHIVED`|409|§5\.6 归档分组转只读：不能再向该组建任务或把任务移进来，`context.group_id` 指名分组|UI / Agent|
|`BREAKDOWN_BAD_STATE`|409|§7\.7 拆解动作从表外状态发起（`confirm` 只允许 `reviewing`，`cancel` 只允许 `receiving`／`reviewing`）。`context` 带 `session_id/status/allowed`|Agent / UI|
|`BREAKDOWN_DRAFT_REF_TAKEN`|409|§7\.4 用户侧「添加任务」显式带的 `ref` 在本会话内已占用（`UNIQUE(session_id, ref)`）。不传 `ref` 由服务端自动取号，走不到这一条。`context` 带 `session_id/ref`|Agent|
|`CREATION_REQUEST_RESOLVED`|409|§8\.7 r3 轻确认决策回传时请求已终结（已建／已取消／已超时含 30s＋5s 宽限）。`context.status` 带归宿，界面据此就地收口卡片|Agent|
|`NOT_IMPLEMENTED`|501|§8\.8 技能源：git／http 远程源本期不实现|UI|
|`DATA_STILL_REFERENCED`|409|2026\-09\-29「报错全部细化」：删除／更新撞上外键，且该外键不是 `CASCADE`（`ON DELETE` 动作为 `NO ACTION`／`SET NULL` 时走不到这里）。业务护栏本该先挡住（见 `ARCHIVE_BLOCKED_BY_DEPENDENCY`／`FIELD_IN_USE`），出现这一枚说明调用方绕过了护栏或库里存在设计外的引用者。`context` 带 `model/detail`|全部|
|`DATA_DUPLICATE`|409|唯一约束或主键冲突（并发写、TOCTOU、导入撞号）。区别于 `IMPORT_ID_CONFLICT`／`SKILL_ID_CONFLICT`：那两枚是预期内的冲突并给出策略选项，这一枚是护栏没兜住时的通用形状。`context` 带 `fields/detail`|全部|
|`SCHEMA_MISMATCH`|500|缺表／缺列：程序与库的 DDL 不一致（迁移链没跑完、旧程序读了新库、手工改过库）。`context` 带 `missing/detail`，`message` 指名是表还是字段|全部|
|`STORAGE_UNAVAILABLE`|503|库文件打不开、磁盘满、IO 错误、数据目录被移动或外接盘拔出——环境侧，重试不一定有用，故与「被占用」分开。`message` 给出检查动作|全部|
|`STORAGE_LOCKED`|503|`SQLITE_BUSY`／`LOCKED`：另一个进程持写锁（同时开了两个本地服务、备份正在跑）。可重试|全部|
|`STORAGE_CORRUPT`|500|`SQLITE_CORRUPT`／`NOTADB`（"file is not a database"）：库文件坏了或被截断，`message` 指向设置页「备份与恢复」|全部|
|`STORAGE_READONLY`|500|`SQLITE_READONLY`／`PERM`、fs 的 `EACCES`／`EPERM`／`EROFS`：数据目录在只读卷上或权限不足|全部|
|`INTERNAL`|500|兜底：`contract/db-errors.ts` 也认不出的抛出（非数据层、非 fs）。`message` 给通用文案，`context.detail` 仍带引擎原文一行，界面折叠区可见——细化不允许吃掉现场|全部|

---

## 附录：关键决策记录

### ADR-001：Agent 审核整链移除（2026-10-09）

**背景**：原设计支持"Agent 当审核方"，让一个 Agent 审核另一个 Agent 的执行结果。

**决策**：移除整条链路，理由：
1. 增加复杂度但未显著提升质量
2. 人工审核 + 免审核已覆盖主要场景
3. 审核即任务的抽象过度设计

**影响**：
- 删除 ReviewQueueService
- 删除 MCP 工具 `claim_next_review` / `submit_review`
- 删除 REST 端点 `/review/escalate`
- review_mode 词表收窄为 human/none

### ADR-002：需求归档放宽（2026-10-09）

**背景**：原有归档逻辑要求任务必须 DONE，导致规划性需求无法归档。

**决策**：需求类型允许在任意状态下归档，前提是：
1. 所有子任务都已完成或已归档
2. 不是其他未完成任务的依赖前置

**影响**：新增错误码 `ARCHIVE_BLOCKED_BY_CHILDREN`

### ADR-003：MCP 服务器名称变更（2026-10-09）

**背景**：产品名称从 "Agent Task Board" 改为 "贾维斯工作台"。

**决策**：MCP_SERVER_NAME 从 `agent-task-board` 改为 `jarvis-workbench`

**影响**：客户端配置需使用新名称，前端配置示例同步更新

---

**文档维护原则**：
- 本文档是唯一标准参考，其他文档均为历史遗留或草案
- 代码变更后须同步更新本文档对应章节
- 重大决策须记录在附录 ADR 中
