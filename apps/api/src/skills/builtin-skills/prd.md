
# PRD Skill

Create and manage Product Requirements Documents (PRDs) for feature planning.

## Workspace (output)

- **Root:** `/root/userdata/workspace/prd/` (matches the skill name `prd`).
- **Only required output rule:** the **final main PRD file** MUST be written to an **absolute path** under this root.
- **Filename is flexible:** choose any name that helps the task, for example `/root/userdata/workspace/prd/电商注册PRD.md` or `/root/userdata/workspace/prd/agents/user-registration.json`.
- **Never write the final PRD** to the current repo, the current file directory, or any cwd-relative path such as `./prd.md`, `./prd.json`, `docs/prd.md`, or `agents/prd.json`.
- **If the directory does not exist, create it first** (for example `mkdir -p /root/userdata/workspace/prd` or a subdirectory under it).
- **If a tool cannot write an absolute path under this root, do not use that tool for the final PRD write.**

## Delivery (`MEDIA:`)

When handing off work to the user, after writing the **final main PRD file**, include in your **visible** reply:

1. A first line: **`生成成功`**
2. One line for the **final main PRD file**: **`MEDIA:`** + **local absolute path** (no space after `MEDIA:`, full path under the workspace root).

**Example:**

```
生成成功
MEDIA:/root/userdata/workspace/prd/agents/current-prd.json
```

If you created optional helper files, you do not need to list them unless the user explicitly asked for them. The default handoff is the final main PRD file only.

**Note:** Any AI-generated PRD-related `.md` file written by this skill needs the AI footer. `.json` or other structured helper files do **not** need `内容由 AI 生成` at the end because appending text would break their format. Prefer handoff examples with `.md` when the deliverable is markdown.

**Example (markdown PRD handoff):**

```
生成成功
MEDIA:/root/userdata/workspace/prd/电商注册PRD.md
```

## AI 内容标识（合规）

千问合规：本 skill **生成或更新**的 `.md` 产物文件，须在**文件最末尾**增加显式标识（非搜索、非格式转换、非整理用户已有文件）。

**本 skill 必须打标：** `/root/userdata/workspace/prd/` 下本回合新建或更新的所有 AI 生成 `.md` 产物，包括最终主 PRD、拆分 PRD、辅助说明文档、评审稿、修订稿等。

**本 skill 不打标：** `agents/*.json` 等 `.json` 文件、用户提供的原始文件、非本 skill 生成/更新的文件；结构化文件不得通过追加尾注破坏格式。

**尾注格式（固定）：** 正文结束后空一行 → `---` → 空一行 → 单独一行：`内容由 AI 生成`（勿插在正文中间）。勿实现 PDF/Office 隐式元数据。

**顺序：** 每个 `.md` 产物最终 `write` → 分别检查文末尾注 → 再输出 `生成成功` / `MEDIA:`（如有文件交付）。是否出现在 `MEDIA:` 中不影响打标要求；多文件产出时，每个符合条件的 `.md` 都要分别追加。修订后重新检查；已有相同尾注勿重复追加。

## What is a PRD?

A **PRD (Product Requirements Document)** is a structured specification that:

1. Breaks a feature into **small, independent user stories**
2. Defines **verifiable acceptance criteria** for each story
3. Orders tasks by **dependency** (schema → backend → UI)

## Quick Start

1. Choose the final PRD file path under **`/root/userdata/workspace/prd/`**
2. Create its parent directory if needed
3. Write the PRD to that absolute path
4. Do **not** save the PRD beside the current repo or current file
5. In your reply, use **Delivery (`MEDIA:`)** above to return that final file path

## PRD JSON Format (filename optional)

```json
{
  "project": "MyApp",
  "branchName": "ralph/feature-name",
  "description": "Short description of the feature",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add priority field to database",
      "description": "As a developer, I need to store task priority.",
      "acceptanceCriteria": [
        "Add priority column: 'high' | 'medium' | 'low'",
        "Generate and run migration",
        "Typecheck passes"
      ],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### Field Descriptions

| Field | Description |
|-------|-------------|
| `project` | Project name for context |
| `branchName` | Git branch for this feature (prefix with `ralph/`) |
| `description` | One-line feature summary |
| `userStories` | List of stories to complete |
| `userStories[].id` | Unique identifier (US-001, US-002) |
| `userStories[].title` | Short descriptive title |
| `userStories[].description` | "As a [user], I want [feature] so that [benefit]" |
| `userStories[].acceptanceCriteria` | Verifiable checklist items |
| `userStories[].priority` | Execution order (1 = first) |
| `userStories[].passes` | Completion status (`false` → `true` when done) |
| `userStories[].notes` | Runtime notes added by agent |

## Story Sizing

**Each story should be completable in one context window.**

### ✅ Right-sized:
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list

### ❌ Too large (split these):
- "Build the entire dashboard" → Split into: schema, queries, UI, filters
- "Add authentication" → Split into: schema, middleware, login UI, session

## Story Ordering

Stories execute in priority order. Earlier stories must NOT depend on later ones.

**Correct order:**
1. Schema/database changes (migrations)
2. Server actions / backend logic
3. UI components that use the backend
4. Dashboard/summary views

## Acceptance Criteria

Must be verifiable, not vague.

### ✅ Good:
- "Add `status` column to tasks table with default 'pending'"
- "Filter dropdown has options: All, Active, Completed"
- "Typecheck passes"

### ❌ Bad:
- "Works correctly"
- "User can do X easily"

**Always include:** `"Typecheck passes"`

## Progress Tracking

If you are only drafting a PRD for the user, `passes` and `notes` can simply remain part of the document schema. You do not need to simulate an execution loop or create extra tracking files unless the user explicitly asks for that workflow.

```json
"notes": "Used IF NOT EXISTS for migrations"
```

## Quick Reference

| Action | Where / what |
|--------|----------------|
| Create PRD | Save the final main file to any absolute path under `/root/userdata/workspace/prd/` |

**Shell (replace `<PRD_PATH>` with the final PRD absolute path):**

```bash
jq '.userStories[] | {id, passes}' <PRD_PATH>
jq '.userStories[] | select(.passes == false)' <PRD_PATH>
```

## Resources

See `references/` for optional supporting material:
- `output-patterns.md` - PRD templates and examples
- `workflows.md` - Optional workflow ideas
- `agent-usage.md` - Optional executor patterns if you intentionally want an agent loop