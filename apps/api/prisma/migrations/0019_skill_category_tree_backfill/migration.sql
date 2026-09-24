-- 技能分类两级树化·数据归位棒（0925 拍板，映射表全量见 docs/0925/二级分类草案.md §2，
-- 拍板覆盖项见草案头部状态标注）：内置 35 行按最终树逐 id 回填叶子终值。
--
-- 范围（35 行 = 31 条 0925 coding 批次 + §9.2 手写样例 code-review + Q3 三条千问产品向）：
-- - coding 31 条：category 由目录 docs/0925/coding-skills-catalog.json 显式给定（Q2 拍板后
--   「叶子=tags 首词」机械规则作废——codexqa-code-reviewer / codexqa-defect-analyzer /
--   devops-code-review 三条按内容改判「质量与安全」，其 tags 阶段词原样保留、与 category 解耦）；
-- - code-review（skl_builtin_code-review）：旧值「质量保障」已作废，语义唯一续位「质量与安全」；
-- - Q3 拍板：千问 prd / prd-generator / brainstorming 三条改判「编码开发/需求与规划」
--   （seed 侧走 CATEGORY_FIXES 补正表，本迁移同值回填）。
-- 其余 90 条千问内置行现值即合法叶子，零改判、不在本文件出现。
--
-- 与 seed 的关系（照 0017「迁移定口径、seed 收敛」双保险）：本文件写下的终值 = 生成器
-- 重跑后的分片值 = ensureDefaultSkills 每次启动 upsert 的值——fresh 重放（0018 建空表、
-- 本迁移空转、seed 直接落终值）与增量升级（存量行被本迁移改到位、seed upsert 同值 no-op）
-- 两条路径收敛一致。tags 面无洗数：阶段词历史上从未进过词表、0016 没洗过它们，本次是
-- 「继续不洗」（freeTagsOf 的阶段词豁免见 skill-categories.ts）。
-- 不改 updated_at：回填是数据归位而非用户编辑（0009/0015/0016/0017/0018 同口径）。
-- 本文件与 0001~0018 一样是权威 DDL/洗数脚本，不要用 `prisma migrate dev` 重算。

-- 编码开发 / 需求与规划（coding 5 + Q3 千问 3）
UPDATE skills SET category = '需求与规划' WHERE id IN (
  'skl_builtin_agent-skills-spec-pack',
  'skl_builtin_product-discovery',
  'skl_builtin_product-methodology',
  'skl_builtin_rc-grill-me',
  'skl_builtin_user-stories-skill',
  'skl_builtin_prd',
  'skl_builtin_prd-generator',
  'skl_builtin_brainstorming'
);

-- 编码开发 / 开发与实现（coding 4：codexqa 两条按 Q2 改判质量与安全，不在此列）
UPDATE skills SET category = '开发与实现' WHERE id IN (
  'skl_builtin_addyosmani-test-driven-development',
  'skl_builtin_api-design',
  'skl_builtin_deprecation-and-migration',
  'skl_builtin_rc-tdd'
);

-- 编码开发 / 质量与安全（coding 6 + Q2 改判 3 + code-review 样例；
-- 其中 8 条此刻可能仍持旧值「质量保障」——0018 已把它们洗成「质量与安全」，
-- 本段对它们是同值 no-op；保留逐条列出是为了 fresh/增量两路径下本文件都是完整口径清单）
UPDATE skills SET category = '质量与安全' WHERE id IN (
  'skl_builtin_bug-hunter',
  'skl_builtin_pragmatic-review',
  'skl_builtin_rc-code-review',
  'skl_builtin_rc-codeprobe',
  'skl_builtin_security-audit-skill',
  'skl_builtin_vercel-optimize',
  'skl_builtin_codexqa-code-reviewer',
  'skl_builtin_codexqa-defect-analyzer',
  'skl_builtin_devops-code-review',
  'skl_builtin_code-review'
);

-- 编码开发 / 代码清理（coding 6）
UPDATE skills SET category = '代码清理' WHERE id IN (
  'skl_builtin_cleanup-comments',
  'skl_builtin_code-refactor',
  'skl_builtin_code-simplify',
  'skl_builtin_merciless-simplification',
  'skl_builtin_refine-code',
  'skl_builtin_simplify-codebase'
);

-- 编码开发 / 运维与协作（coding 5：devops-code-review 按 Q2 改判质量与安全，不在此列）
UPDATE skills SET category = '运维与协作' WHERE id IN (
  'skl_builtin_agent-ops-cicd-github',
  'skl_builtin_commit-plan',
  'skl_builtin_git-worktree',
  'skl_builtin_github-ci',
  'skl_builtin_rain-skills'
);

-- 编码开发 / 测试自动化（coding 2）
UPDATE skills SET category = '测试自动化' WHERE id IN (
  'skl_builtin_awesome-qa-skills',
  'skl_builtin_dsh-qa-skills'
);
