import type { PrismaService } from '../infra/prisma.service';
import { nowSql } from '../contract/time';
import { BUILTIN_SKILL_SEEDS } from './builtin-skills';
import { DEFAULT_SKILL_VERSION, type SkillContent, type SkillMcpDependency, type SkillType } from './skills.dto';

/**
 * v0.0.4 #19（W2/W3 遗留）① 默认技能首次启动预置清单（PRD §20.5-15、验收 49）。
 *
 * 口径：默认技能=应用预置、只读（§9.1）、无版本历史、`current_version` 固定 `builtin`
 * （§9.6），随安装包整体更新（§3.1/§3.2「builtin/ + SQLite 元数据」）。机制（只读守卫、
 * builtin 版本、W2 0010 三来源迁移）已具备，此处只补「预置种子清单本体」——不改迁移，
 * 走代码按 id upsert（schema 冻结）。
 *
 * 清单来源：#19 落 PRD §9.2 规范样例「代码审查」1 条；v0.0.4 #41 批量并入千问工作台
 * 技能迁移的 93 条内置种子（BUILTIN_SKILL_SEEDS，正文走 builtin-skills.data 分片，
 * 口径与映射表见 docs/v0.0.4/千问技能迁移映射表.md）。
 */
export interface DefaultSkillSeed {
  /** 稳定 id：预置按此 id upsert，导出/绑定引用终身不变（§9.2 唯一 id 口径）。 */
  id: string;
  name: string;
  type: SkillType;
  description: string;
  tags: string[];
  content: SkillContent;
  mcpDependencies: SkillMcpDependency[];
}

/** §9.2 SKILL.md 规范样例「代码审查」落为唯一内置默认技能（prompt 入口 + 四步流程）。 */
const CODE_REVIEW: SkillContent = {
  blocks: [
    {
      id: 'b-entry',
      kind: 'prompt',
      title: '代码审查',
      prompt: '对代码 diff 做风格、安全、逻辑三层审查，最后汇总为审查报告。',
      next: [{ when: '', to: 'b-steps' }],
    },
    {
      id: 'b-steps',
      kind: 'step',
      title: '步骤',
      steps: [
        '代码风格检查：核对 {{diff}} 是否符合项目代码风格规范。',
        '安全检查：核对 {{diff}} 是否存在安全隐患。',
        '逻辑审查：核对 {{diff}} 的逻辑正确性。',
        '生成报告：汇总以上结果，生成审查报告。',
      ],
      next: [{ when: '', to: '' }],
    },
  ],
  entryBlockId: 'b-entry',
};

export const DEFAULT_SKILL_SEEDS: DefaultSkillSeed[] = [
  {
    id: 'skl_builtin_code-review',
    name: 'code-review',
    type: 'flow',
    description: '对代码 diff 做风格、安全、逻辑三层审查',
    tags: ['review', 'quality'],
    content: CODE_REVIEW,
    mcpDependencies: [{ server: 'github', tools: ['get_pull_request'], required: false, reason: '拉取待审查 diff' }],
  },
  // v0.0.4 #41：千问工作台技能批量迁移的内置种子（清洗正文→.ts 分片→markdownToBlocks）。
  ...BUILTIN_SKILL_SEEDS,
];

export interface DefaultSkillSeedResult {
  created: string[];
  updated: string[];
}

/**
 * 启动时按 id upsert 默认技能：库内缺该行则新建（source=default、版本 builtin、只读派生）；
 * 已存在则刷新内置提供的元数据与内容（对齐「随安装包整体更新」），id/created_at 不动。
 * 幂等：重复执行不产生副本。默认技能不可被用户编辑（§9.1 只读守卫），刷新不会覆盖用户改动。
 */
export async function ensureDefaultSkills(prisma: PrismaService): Promise<DefaultSkillSeedResult> {
  const created: string[] = [];
  const updated: string[] = [];
  // #41 后种子近百条：存在性一次查齐，避免每条 seed 两次往返。
  const seededIds = DEFAULT_SKILL_SEEDS.map((seed) => seed.id);
  const existingRows = await prisma.skill.findMany({ where: { id: { in: seededIds } }, select: { id: true } });
  const existingIds = new Set(existingRows.map((row) => row.id));
  for (const seed of DEFAULT_SKILL_SEEDS) {
    const builtin = {
      name: seed.name,
      type: seed.type,
      description: seed.description,
      tags: JSON.stringify(seed.tags),
      currentVersion: DEFAULT_SKILL_VERSION,
      content: JSON.stringify(seed.content),
      mcpDependencies: JSON.stringify(seed.mcpDependencies),
      sourceType: 'default',
    };
    if (existingIds.has(seed.id)) {
      await prisma.skill.update({ where: { id: seed.id }, data: { ...builtin, updatedAt: nowSql() } });
      updated.push(seed.id);
    } else {
      await prisma.skill.create({
        data: { id: seed.id, status: 'PUBLISHED', testCases: '[]', ...builtin },
      });
      created.push(seed.id);
    }
  }
  return { created, updated };
}
