
# Brainstorming

This skill enforces design-before-implementation to prevent costly rework and clarify requirements.

## Core Principle

**HARD-GATE: No code or implementation until design is approved.**

This is non-negotiable. Time pressure, user authority, simplicity, or urgency are NOT valid reasons to skip design.

## Process

### 1. Check Context

Before asking questions, review existing context to avoid redundant questions:

- **MEMORY.md** - User preferences, past decisions, technical context (main session only)
- **USER.md** - User profile, preferences, communication style
- **memory/YYYY-MM-DD.md** - Today's and yesterday's activity logs
- **Related docs** - Check `/root/.openclaw/memory/skills/brainstorming/docs/` for existing designs or decisions

### 2. Ask Clarifying Questions

Ask 2-5 clarifying questions **one at a time** to understand:

- Core functionality vs nice-to-have features
- Storage/persistence requirements
- User interface preferences
- Integration points with existing systems
- Non-functional requirements (performance, security, etc.)

**Rules:**
- Ask questions even if user says "I know what I want"
- Keep questions focused and specific
- Wait for answer before next question
- Build on previous answers

### 3. Propose Approaches

Present 2-3 distinct approaches with:

- **High-level architecture** - Major components and data flow
- **Trade-offs** - Pros/cons of each approach
- **Recommendation** - Which approach you recommend and why

Keep this section brief (3-5 sentences per approach).

### 4. Present Design

After user selects approach, present detailed design in digestible sections:

**A. Architecture Overview**
- Component diagram (ASCII art or description)
- Data flow
- Key dependencies

**B. Implementation Details**
- File structure with exact paths
- Key functions/modules with responsibilities
- Data models/schemas

**C. Open Questions**
- Any remaining unknowns
- Decisions user needs to make

**D. Next Steps**
- What happens after approval
- Estimated complexity

### 5. Get Approval

**Explicitly ask:** "Does this design look good? Any changes needed?"

Wait for approval. Do NOT proceed to implementation without explicit confirmation.

### 6. Save Design

Upon approval, save the design to:

```
/root/.openclaw/memory/skills/brainstorming/docs/plans/YYYY-MM-DD-<topic>-design.md
```

**AI labeling:** Before handoff, the saved design `.md` must end with `---` + `内容由 AI 生成` at the **end of the file** (see **AI 内容标识（合规）** below). Do not label unsaved drafts or MEMORY files.

Include:
- Date and context
- Full design from step 4
- User's approval confirmation
- Reference to next skill (writing-plans)

### 7. Invoke Next Skill

After saving, invoke the `writing-plans` skill:

"Design approved and saved. Invoking writing-plans skill to break this into executable tasks."

## Rationalization Resistance

Common excuses for skipping design and why they're wrong:

| Excuse | Why It's Wrong | Counter |
|--------|----------------|---------|
| "User is in a hurry" | Quick design (2-5 min) prevents slow rework (hours/days) | Time pressure makes design MORE important, not less |
| "User knows what they want" | Users know goals, not implementation details | Questions reveal hidden requirements and assumptions |
| "It's simple, doesn't need design" | "Simple" projects hide the most assumptions | Simple projects need simple designs (still designs) |
| "No long discussions needed" | Design ≠ long discussion | Design can be 2 minutes. Approval can be one word. |
| "User gave detailed specs" | Specs describe what, not how | Design clarifies architecture, trade-offs, and approach |
| "Just a prototype/MVP" | Prototypes become production code | Good architecture costs the same time upfront |
| "We can refactor later" | Later never comes | Design now or debug forever |

**The rule:** If you're typing code, you skipped a step.

## Red Flags

Watch for these signs you're about to violate the hard-gate:

🚩 You're thinking about file structure before getting approval
🚩 You're considering library choices before presenting approaches
🚩 You're writing pseudocode before user responds
🚩 You catch yourself thinking "I'll just start with..."
🚩 You're rationalizing why THIS case is different
🚩 User says "just start" and you feel compelled to obey

**When you see red flags:** Stop. Return to step 2 (questions) or step 5 (get approval).

## OpenClaw Integration

### Memory Context

**Main session (direct user chat):**
- Read MEMORY.md for long-term context
- Check memory/YYYY-MM-DD.md for recent decisions
- Reference past designs in /root/.openclaw/memory/skills/brainstorming/docs/plans/

**Shared contexts (Discord, groups):**
- Skip MEMORY.md (contains private data)
- Use only USER.md and current conversation context

### Workspace Organization

All designs save to:
```
/root/.openclaw/memory/skills/brainstorming/docs/plans/YYYY-MM-DD-<descriptive-name>-design.md
```

Examples:
- `2026-02-25-todo-cli-design.md`
- `2026-02-25-user-auth-design.md`
- `2026-02-25-api-refactor-design.md`

## AI 内容标识（合规）

千问合规：本 skill **生成或更新**的 `.md` 产物文件，须在**文件最末尾**增加显式标识（非搜索、非格式转换、非整理用户已有文件）。

**本 skill 必须打标：** 本回合新建或更新的 AI 生成 `.md` 设计产物，包括用户审批后保存至 `/root/.openclaw/memory/skills/brainstorming/docs/plans/YYYY-MM-DD-*-design.md` 的设计文档，以及同一目录下由本 skill 生成/更新的补充设计说明。

**本 skill 不打标：** 未保存的对话草稿、用户或系统已有的 MEMORY.md / USER.md / 日常 memory 日志；非本 skill 生成/更新的文件。

**尾注格式（固定）：** 正文结束后空一行 → `---` → 空一行 → 单独一行：`内容由 AI 生成`（勿插在正文中间）。勿实现 PDF/Office 隐式元数据。

**顺序：** 每个 `.md` 产物最终 `write` → 分别检查文末尾注 → 再 invoke `writing-plans` 或告知保存完成。多文件产出时，每个符合条件的 `.md` 都要分别追加。修订后重新检查；已有相同尾注勿重复追加。

### Skill Chaining

After approval and save:
1. Explicitly state design is approved
2. Confirm save location
3. Invoke `writing-plans` skill
4. Do NOT start implementation yourself

## Edge Cases

### "What if user insists on skipping design?"

Respond with:
> "I understand you want to move quickly. A 2-minute design will save hours of rework. Let me ask 2 quick questions, propose an approach, and get your thumbs-up. Total time: 3 minutes. Deal?"

### "What if it's a trivial change?"

Even trivial changes get lightweight design:
> "Quick design: Change X in file Y because Z. Sound good?"

Wait for confirmation before implementing.

### "What if design was done externally?"

If user provides existing design document:
1. Review it
2. Ask 1-2 clarifying questions about implementation details
3. Save to /root/.openclaw/memory/skills/brainstorming/docs/plans/ for reference
4. Get approval to proceed
5. Invoke writing-plans skill

### "What if this is iteration on existing design?"

Reference previous design:
> "Building on the design from 2026-02-20-todo-cli-design.md. Proposed change: [describe change]. This affects: [components]. Sound good?"

Wait for approval before implementing.

## Anti-Pattern Examples

### ❌ Bad: Immediate Implementation
```
User: "Build a todo CLI"
Agent: *writes complete Python application*
```

### ✅ Good: Design First
```
User: "Build a todo CLI"
Agent: "Great! Quick questions:
1. How should todos be stored? (JSON file / SQLite / plain text)
2. Need due dates or just simple list?"

[After answers...]

Agent: "Here are 2 approaches:

A. Simple JSON file + Python CLI
   - Pros: Easy to inspect/backup, no dependencies
   - Cons: Not ideal for large lists, manual file locking
   
B. SQLite + Python CLI
   - Pros: Better for large lists, built-in queries
   - Cons: Binary format, slightly more complex

I recommend A for simplicity unless you expect >1000 todos. Thoughts?"

[After user picks A...]

Agent: "Design:

Architecture:
- Single Python script: todo.py
- JSON storage: ~/.todos.json
- Commands: add, list, done, delete

Implementation:
```
todo.py (main CLI)
  - add_todo(text) → append to JSON
  - list_todos() → read JSON, display
  - mark_done(id) → update JSON
  - delete_todo(id) → remove from JSON
  
~/.todos.json structure:
[
  {"id": 1, "text": "...", "done": false},
  ...
]
```

Does this design work for you?"

[Wait for approval...]

Agent: "Approved! Saving to /root/.openclaw/memory/skills/brainstorming/docs/plans/2026-02-25-todo-cli-design.md and invoking writing-plans skill."
```

## Success Criteria

You've successfully used this skill when:

✅ No code written before approval
✅ At least 2 clarifying questions asked
✅ Multiple approaches presented
✅ Design saved to /root/.openclaw/memory/skills/brainstorming/docs/plans/
✅ User gave explicit approval ("yes", "looks good", "approved", etc.)
✅ writing-plans skill invoked for next phase

## Failure Modes

You've violated this skill if:

❌ Code appears before design approval
❌ Jumped straight to implementation
❌ Rationalized why design wasn't needed
❌ User pressure caused you to skip steps
❌ Wrote pseudocode before getting approach approval
❌ Saved design but implemented before invoking writing-plans

**When you catch yourself failing:** Stop immediately. Delete any code. Return to the process.

---

*Based on obra/superpowers methodology. Pressure-tested and hardened against rationalization.*
