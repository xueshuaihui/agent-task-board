以下是按产研阶段整理的专项 Agent 技能表格，涵盖需求规划、开发实现、质量安全、代码清理、运维协作等环节，并补充了更多热门技能。

## 📋 需求与规划

| 产研阶段 | 技能名称 | 核心用途 | 详细功能描述 | 核心优势 | GitHub 仓库地址 |
|---|---|---|---|---|---|
| **需求与规划** | **grill-me** | 用追问澄清模糊需求 | 让 AI 扮演"特别烦人的面试官"，通过连续追问帮你把模糊需求中的关键假设和缺口逐一确认清楚 | 被评价为"让工程师集体上头"的规划类技能，能在编码前消除大量返工 | `rightcodehere/skills`（/rc-grill-me） |
| **需求与规划** | **user-stories-skill** | 将目标拆解为可实现的用户故事 | 自动分析代码库架构，将目标拆解为 2-4 小时可实现的原子用户故事，包含依赖排序、验收标准、动态文件命名，支持 JSON 和 Gherkin（BDD）两种输出格式 | 产物可直接用于任务分配和验收，支持 Plan Mode 不会修改代码 | [felipereisdev/user-stories-skill](https://github.com/felipereisdev/user-stories-skill) |
| **需求与规划** | **agent-skills-spec-pack** | 契约优先的规格编写 | 涵盖 charter、user stories、requirements、technical design、execution plan、task tracking 六大产出物，支持从产品意图到实现、以及从现有代码库反向重建规格两个方向 | 每个技能职责单一，产出物契约稳定，内置溯源和血缘追踪，减少范围漂移和架构漂移 | [urban/agent-skills-spec-pack](https://github.com/urban/agent-skills-spec-pack) |
| **需求与规划** | **product-methodology** | 产品优先级与决策 | 支持 RICE、MoSCoW、机会解决方案树、决策日志、PRD 编写、干系人沟通、功能优先级排序、Backlog 排序、发布范围、自建 vs 采购决策等 | 将产品经理的核心方法论封装为可复用技能，适合需要结构化决策的场景 | `magnus919/agent-skills`（product-methodology） |
| **需求与规划** | **product-discovery** | 干系人访谈与需求发现 | 支持干系人映射、访谈指南、发现对话、转录转规格、需求冲突处理、"什么必须为真"、Pre-mortem、Laddering、假设打破等 | 专注于发现阶段的结构化方法，适合从零开始探索产品方向 | `magnus919/agent-skills`（product-discovery） |

## 💻 开发与实现

| 产研阶段 | 技能名称 | 核心用途 | 详细功能描述 | 核心优势 | GitHub 仓库地址 |
|---|---|---|---|---|---|
| **开发与实现** | **tdd（rc-tdd）** | 强制执行 TDD 红绿重构循环 | 以垂直切片方式构建功能，每次循环包含 RED（写失败测试）→ GREEN（最小实现）→ REFACTOR（重构），强调接口设计优先 | 确保 AI 写的每一行代码都有测试覆盖，避免"先写代码后补测试"的反模式 | `rightcodehere/skills`（/rc-tdd） |
| **开发与实现** | **test-driven-development** | TDD 全流程指导 | 在实现任何逻辑、修复 Bug 或改变行为时使用，强制先写失败测试再写实现代码，Bug 修复时先用测试复现问题 | 来自 Addy Osmani 的 agent-skills，将 TDD 作为通用开发纪律强制执行 | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)（skills/test-driven-development） |
| **开发与实现** | **codexqa-defect-analyzer** | 代码缺陷与安全分析 | 将 SAST/Lint/密钥扫描与 Agent 语义分析合并为一次 P0-P3 HTML 报告，包含位置、证据、修复建议 | 完全本地运行，无需账号，支持 10 种语言，在盲测中实现 7/7 召回率、0 误报 | [openqa-cn/codexqa](https://github.com/openqa-cn/codexqa) |
| **开发与实现** | **codexqa-code-reviewer** | 变更合并就绪审查 | 收集调用方、影响范围、测试边缘等证据包，生成双语 REVIEW-REPORT.html 审查报告，可直接发送给 Reviewer | 不仅看 diff，还追踪调用链和测试缺口，解决"AI PR 遗漏业务逻辑 Bug"的问题 | [openqa-cn/codexqa](https://github.com/openqa-cn/codexqa) |
| **开发与实现** | **database** | 数据库 Schema 设计与迁移 | 覆盖 Schema 设计、安全可逆迁移脚本、慢查询优化，强调零停机迁移（Expand-Contract 模式） | 专注于生产级数据库变更，避免停机风险 | 来自 Addy Osmani agent-skills 生态 |
| **开发与实现** | **API 设计** | API 接口设计规范 | 在 Build 阶段提供 API 设计的结构化指导，确保接口契约清晰、可维护 | 来自 Addy Osmani 的 Define→Plan→Build→Verify 全流程体系 | `addyosmani/agent-skills` |

## 🔍 质量与安全

| 产研阶段 | 技能名称 | 核心用途 | 详细功能描述 | 核心优势 | GitHub 仓库地址 |
|---|---|---|---|---|---|
| **质量与安全** | **rc-codeprobe** | 九维度综合代码审计 | 全编排器，运行 `/rc-codeprobe audit <path>` 即可完成 9 个域的综合审计，包含 SOLID 原则、安全漏洞、架构问题、代码异味、设计模式、性能、错误处理、测试质量、框架惯用法 | 一个命令覆盖所有审计维度，46 个经过实战验证的技能之一 | `rightcodehere/skills`（/rc-codeprobe） |
| **质量与安全** | **rc-code-review** | 综合 PR 审查 | 四阶段流程，包含严重程度标签和 17+ 语言指南 | 结构化的 PR 审查流程，适合团队协作场景 | `rightcodehere/skills`（/rc-code-review） |
| **质量与安全** | **security-audit-skill** | 多阶段安全审计 | 具有独立验证、机器可读结果的多阶段安全审计，适合在 CI/CD 流程中集成自动化安全检查 | 来自 Cloudflare 官方，在 GitHub 趋势榜单中排名靠前 | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) |
| **质量与安全** | **bug-hunter** | 对抗性 AI Bug 猎手 | 多 Agent 流水线，自动发现安全漏洞、逻辑错误和运行时 Bug，并在安全分支上自主修复 | 支持 Claude Code、Cursor、Codex CLI、GitHub Copilot CLI 等多种工具 | [codexstar69/bug-hunter](https://github.com/codexstar69/bug-hunter) |
| **质量与安全** | **pragmatic-review** | 资深工程师视角代码审查 | 对分支 diff 进行 DRY/YAGNI/SOLID/Pragmatic Programmer 原则审查，React/RN 项目委托给 Vercel React 技能 | 跨 Agent 兼容，同一套文件可用于 Claude Code、Codex、OpenCode | [msobczyk-x/agent-skills](https://github.com/msobczyk-x/agent-skills)（pragmatic-review） |
| **质量与安全** | **vercel-optimize** | Vercel 性能与成本优化 | 审计成本、性能、可靠性、缓存、函数使用和账单，产出按优先级排序的报告 | 来自 Vercel 工程团队，针对 Vercel 部署场景深度优化 | `vercel-labs/skills` 生态 |

## 🧹 代码清理与重构

| 产研阶段 | 技能名称 | 核心用途 | 详细功能描述 | 核心优势 | GitHub 仓库地址 |
|---|---|---|---|---|---|
| **代码清理** | **simplify-codebase** | 安全移除偶然复杂度 | 识别重复状态、失去所有者的抽象、只剩测试消费的接口、无效兼容路径等，追踪运行时消费者、动态注册、持久化格式后再决定删除/合并/保留 | 不追求"删得多"，关心的是删除一个需要长期维护的事实或契约，每个候选都形成证明记录 | [tt-a1i/simplify-codebase](https://github.com/tt-a1i/simplify-codebase) |
| **代码清理** | **merciless-simplification** | 系统性消除代码复杂度 | 在保持 100% 外部可观察行为（向后兼容、仅实现变更）的前提下，系统性地消除代码复杂度 | 强调"无情简化"，但严格保护可观察行为不变 | [mfenderov/merciless-simplification](https://github.com/mfenderov/merciless-simplification) |
| **代码清理** | **cleanup-comments** | 清理冗余注释 | 修剪当前 diff 中嘈杂/冗余的注释，让代码保持自解释 | 轻量、专注，只处理注释问题，不改变代码行为 | [msobczyk-x/agent-skills](https://github.com/msobczyk-x/agent-skills)（cleanup-comments） |
| **代码清理** | **code-simplify** | 简化代码不改变行为 | 在不改变行为的前提下简化当前 diff 中的代码 | 与 cleanup-comments 配合使用，precommit-simplify 会在提交前自动运行两者 | [msobczyk-x/agent-skills](https://github.com/msobczyk-x/agent-skills)（code-simplify） |
| **代码清理** | **code-refactor** | React/RN 代码结构重构 | 将 JS/TS React & React Native 代码重构为每个文件单一职责（拆分组件/常量，使用 index.tsx 模式） | 专门针对 React 生态的结构化重构 | [msobczyk-x/agent-skills](https://github.com/msobczyk-x/agent-skills)（code-refactor） |
| **代码清理** | **refine-code** | 任意规模代码改进 | 从清理单个函数到重构整个模块层次，再到证明哪些代码可以安全删除，均可处理 | 覆盖任意规模，强调"证明可安全删除"而非盲目删除 | `vaayne/agent-kit`（refine-code） |

## 🔧 运维与协作

| 产研阶段 | 技能名称 | 核心用途 | 详细功能描述 | 核心优势 | GitHub 仓库地址 |
|---|---|---|---|---|---|
| **运维与协作** | **commit-plan** | 逻辑提交规划 | 从当前 diff 提议逻辑提交——每个提交包含 Conventional Commit 消息和要暂存的文件，确认后创建，不推送、不在消息中留下 Agent 署名 | 保持 Git 历史清晰，提交信息规范 | [msobczyk-x/agent-skills](https://github.com/msobczyk-x/agent-skills)（commit-plan） |
| **运维与协作** | **github-ci** | GitHub Actions CI 工作流 | 编写和维护 GitHub Actions CI 工作流、触发器、Runner 和缓存 | 来自 greedychipmunk/agent-skills，涵盖 DevOps 全领域 | [greedychipmunk/agent-skills](https://github.com/greedychipmunk/agent-skills)（github-ci） |
| **运维与协作** | **agent-ops-cicd-github** | GitHub Actions CI/CD 流水线创建与优化 | 创建高效的 GitHub Actions 工作流，实现构建、测试、部署流水线，配置多环境测试矩阵，设置缓存与制品管理，实施安全最佳实践 | 专注于 GitHub Actions 的专项 DevOps 技能 | `ruvnet/ruflo`（agent-ops-cicd-github） |
| **运维与协作** | **devops-skills** | DevOps 技能集合 | 代码审查（分析两个本地 Git 分支间的变更）、提交代码（分析变更、准备 Conventional Commit 消息、提交到新分支） | 可跨 Claude Code、GitHub Copilot、OpenCode、Cursor 等使用 | [abdullahkhawer/devops-skills](https://github.com/abdullahkhawer/devops-skills) |
| **运维与协作** | **RainSkills** | Rainbond 应用部署与排障 | 通过 Rainbond MCP 将项目接入 Rainbond，完成应用部署、运行排障、交付验证和版本管理 | Rainbond 官方开源，与 AI 编码工具深度集成 | `Rainbond/RainSkills` |
| **运维与协作** | **git-worktree** | Git Worktree 管理 | 只管理本地 Git worktree/branch 的创建、交付、合并、保留、救援与安全清理，不涉及 push | 适合并行开发场景，避免多分支切换的冲突 | `git-worktree` 技能包 |

## 🧪 测试自动化（补充）

| 产研阶段 | 技能名称 | 核心用途 | 详细功能描述 | 核心优势 | GitHub 仓库地址 |
|---|---|---|---|---|---|
| **测试自动化** | **awesome-qa-skills** | 测试工程全流程技能库 | 按语言分区（zh/en），覆盖需求分析、策略、用例设计、执行、缺陷与报告全链路，含 4 个测试工作流和 25 个测试类型技能（58 个技能文件夹） | 每个技能可独立安装、可组合调用，附带 evals 评测用例，支持 skill-up 校验 | [naodeng/awesome-qa-skills](https://github.com/naodeng/awesome-qa-skills) |
| **测试自动化** | **dsh-qa-skills** | 让 AI 像资深测试工程师一样工作 | 覆盖写用例、审查、转自动化、回归范围等阶段，无需走完整流水线即可单独调用某个阶段 | 知识 × 工具 × 决策三位一体的测试工程框架 | `dsh-qa-skills` |
| **测试自动化** | **codexqa-defect-analyzer** | 业务逻辑 Bug 发现 | 合并 SAST/Lint/密钥扫描与 Agent 语义分析，生成 P0-P3 HTML 报告 | 在 JS 盲测中实现 7/7 召回率、0 误报，完全本地运行 | [openqa-cn/codexqa](https://github.com/openqa-cn/codexqa) |

## 📊 按阶段速查总结

| 产研阶段 | 推荐入门技能 | 备选技能 |
|---|---|---|
| **需求与规划** | `grill-me`（追问澄清） | `user-stories-skill`、`product-methodology` |
| **开发与实现** | `tdd`（TDD 循环） | `codexqa-defect-analyzer`、`database` |
| **质量与安全** | `rc-codeprobe`（九维度审计） | `security-audit-skill`、`bug-hunter` |
| **代码清理** | `simplify-codebase`（安全简化） | `cleanup-comments`、`merciless-simplification` |
| **运维与协作** | `commit-plan`（提交规划） | `github-ci`、`RainSkills` |
| **测试自动化** | `awesome-qa-skills`（测试全流程） | `dsh-qa-skills` |

这些技能大多遵循 `SKILL.md` 开放标准，可跨 Cursor、Claude Code、GitHub Copilot 等工具使用。安装方式通常是将技能文件夹放入对应工具的 skills 目录（如 `~/.claude/skills/`、`~/.cursor/skills/`），或通过 `npx skills add <repo>` 一键安装。
