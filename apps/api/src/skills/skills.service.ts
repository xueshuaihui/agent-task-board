import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import type { Skill, SkillVersion } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import { freeTagsOf, parentOfCategory } from './skill-categories';
import {
  LEGACY_SOURCE_TYPES,
  nextPatchVersion,
  parseJson,
  toSkillCategory,
  type SkillContent,
  type SkillCreateInput,
  type SkillDto,
  type SkillBriefDto,
  type SkillBriefListResult,
  type SkillImportMarkdownInput,
  type SkillListQuery,
  type SkillMatchField,
  type SkillMcpDependency,
  type SkillOrigin,
  type SkillPatchInput,
  type SkillSearchHit,
  type SkillSearchResult,
  type SkillSource,
  type SkillStatus,
  type SkillTestCase,
  type SkillTestResult,
  type SkillType,
  type SkillVersionCreateInput,
  type SkillVersionSnapshotDto,
  type SkillVersionSummary,
  type TaskSkillPayload,
  type TaskSkillRef,
} from './skills.dto';
import { blocksToMarkdown, markdownToBlocks, parseFrontmatter } from './skill-markdown';
import { scanDirectory } from './skill-sources';
import { findSkillRefCycle, subskillRefs, subskillRefsOfJson } from './skill-reference';

const INITIAL_VERSION = 'v0.1.0';
const EMPTY_CONTENT: SkillContent = { blocks: [], entryBlockId: null };

/** 导入文件硬顶：技能文件是几 KB 的 JSON，1MB 已经是千倍余量。 */
export const SKILL_IMPORT_MAX_BYTES = 1024 * 1024;

/** 8.8 技能源在 settings kv 里的键（settings 总表之外的技能模块私有键）。 */
export const SKILL_SOURCES_SETTING_KEY = 'skill_sources';

/** 8.8 内置源默认种子：不落库，GET 时若无 builtin 条目动态补一条。 */
const BUILTIN_SOURCE: SkillSource = {
  id: 'builtin',
  type: 'builtin',
  name: '内置技能',
  path: '',
  enabled: true,
};

interface ParsedSkill {
  content: SkillContent;
  mcpDependencies: SkillMcpDependency[];
  tags: string[];
  testCases: SkillTestCase[];
}

function parseSkill(row: Skill): ParsedSkill {
  return {
    content: parseJson<SkillContent>(row.content, EMPTY_CONTENT),
    mcpDependencies: parseJson<SkillMcpDependency[]>(row.mcpDependencies, []),
    tags: parseJson<string[]>(row.tags, []),
    testCases: parseJson<SkillTestCase[]>(row.testCases, []),
  };
}

function toDto(row: Skill): SkillDto {
  const parsed = parseSkill(row);
  const source: SkillOrigin = (row.sourceType === 'default' || row.sourceType === 'imported')
    ? row.sourceType
    : 'custom';
  return {
    id: row.id,
    name: row.name,
    type: row.type as SkillType,
    status: row.status as SkillStatus,
    description: row.description,
    tags: parsed.tags,
    // 列值经 0018 收敛后的 CHECK 保证在 16 叶子词表内；读侧再过一次 toSkillCategory 纯属防脏库炸类型。
    category: toSkillCategory(row.category),
    current_version: row.currentVersion,
    content: parsed.content,
    test_cases: parsed.testCases,
    mcp_dependencies: parsed.mcpDependencies,
    source,
    // §9.1 默认技能只读：服务层守卫同样按此判定，列上不存 readonly。
    readonly: source === 'default',
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

// ---------------------------------------------------------------- 发现面（MCP 精简读）

/**
 * 发现面的列投影：`content` / `test_cases` / `mcp_dependencies` 三列**不进 SQL 结果**。
 *
 * WHY 单独一套：`list()` / `detail()` 回的是 REST 与编辑器要的完整 `SkillDto`（带正文），
 * 而 `list_skills` / `search_skills` 只是「让 agent 知道有哪些技能」。实测 124 条内置技能
 * 完整 JSON = 1.0 MB，只要 id/name/type/description 时是 22 KB——差 45 倍，差距全在正文列。
 * 用同一个 findMany() 会在解码阶段就把 1 MB 拉出来（125 行 × 平均 8.3 KB），所以连 SQL 层
 * 也要把正文列摘掉，而不是查出来再丢。
 */
const SKILL_BRIEF_SELECT = {
  id: true,
  name: true,
  type: true,
  status: true,
  description: true,
  tags: true,
  category: true,
  sourceType: true,
  currentVersion: true,
  updatedAt: true,
} as const;

type SkillBriefRow = {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string;
  tags: string | null;
  category: string | null;
  sourceType: string | null;
  currentVersion: string;
  updatedAt: string | null;
};

/** 目录里的一句话描述上限：候选展示够用，又不至于把 2000 字的描述整段塞进上下文。 */
const BRIEF_DESCRIPTION_CLIP = 120;

function sourceOf(row: { sourceType: string | null }): SkillOrigin {
  return row.sourceType === 'default' || row.sourceType === 'imported' ? row.sourceType : 'custom';
}

function toBrief(row: SkillBriefRow): SkillBriefDto {
  const description = row.description ?? '';
  const source = sourceOf(row);
  return {
    skill_id: row.id,
    name: row.name,
    description:
      description.length > BRIEF_DESCRIPTION_CLIP
        ? `${description.slice(0, BRIEF_DESCRIPTION_CLIP)}…`
        : description,
    type: row.type as SkillType,
    status: row.status as SkillStatus,
    category: toSkillCategory(row.category ?? ''),
    tags: parseJson<string[]>(row.tags, []),
    source,
    // §9.1 只读判定与 toDto 同一口径：按来源推导，列上不存 readonly。
    readonly: source === 'default',
    current_version: row.currentVersion,
    updated_at: toIso(row.updatedAt),
  };
}

/** 中文字符二元组：中文没有空格分词，"代码评审" vs "代码审查" 靠它拿到非零相似度。 */
function bigrams(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/\s+/gu, '')];
  const set = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    set.add(`${chars[index]}${chars[index + 1]}`);
  }
  if (chars.length === 1) set.add(chars[0]!);
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface Scored {
  score: number;
  matched_on: SkillMatchField;
}

/**
 * 单个词项的打分。分值阶梯（顺序即优先级）：
 * 名称全等 100 / 前缀 80 / 子串 70 / 分类 50 / 标签 45 / 描述 30 / 相似度 ≤30。
 *
 * 相似度必须兜住「用户说的和库里的名字不一样」——子串匹配对近义词是无能为力的
 * （"代码评审" 与 "代码审查" 互相不含），而这类不命中正是用户被迫回平台查名字的直接原因。
 */
function scoreOne(row: SkillBriefRow, term: string): Scored {
  const query = term.toLowerCase();
  if (!query) return { score: 0, matched_on: 'none' };
  const name = row.name.toLowerCase();
  if (name === query) return { score: 100, matched_on: 'name_exact' };
  if (name.startsWith(query)) return { score: 80, matched_on: 'name_prefix' };
  if (name.includes(query)) return { score: 70, matched_on: 'name' };

  const category = toSkillCategory(row.category ?? '');
  if (category !== '' && (category === term || parentOfCategory(category) === term)) {
    return { score: 50, matched_on: 'category' };
  }
  const tags = parseJson<string[]>(row.tags, []);
  if (tags.some((tag) => tag.toLowerCase() === query)) return { score: 45, matched_on: 'tag' };

  const description = (row.description ?? '').toLowerCase();
  if (description.includes(query)) return { score: 30, matched_on: 'description' };

  const similarity = Math.max(
    jaccard(bigrams(query), bigrams(name)),
    jaccard(bigrams(query), bigrams(description)) * 0.8,
  );
  // 阈值 0.15 是实测口径：3 个 bigram 里命中 1 个（如 "代码评审" vs "代码审查"）即 0.2，
  // 能进候选；再低就会把全库都捞成 similarity，候选反而失效。
  if (similarity >= 0.15) {
    return { score: Math.max(5, Math.round(similarity * 30)), matched_on: 'similarity' };
  }
  return { score: 0, matched_on: 'none' };
}

/** 多词查询（"code review" / "审查 代码"）按词项取最高分，取最像的那个命中面。 */
function scoreCandidate(row: SkillBriefRow, keyword: string): Scored {
  const terms = [...new Set(
    [keyword, ...keyword.split(/[\s,，、;；/]+/u)]
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  )];
  let best: Scored = { score: 0, matched_on: 'none' };
  for (const term of terms) {
    const scored = scoreOne(row, term);
    if (scored.score > best.score) best = scored;
  }
  return best;
}

/** 目录/搜索共用的元数据过滤（类型/状态/来源/标签），不含关键字。 */
function matchesMetaFilter(row: SkillBriefRow, query: SkillListQuery): boolean {
  if (query.type && row.type !== query.type) return false;
  if (query.status && row.status !== query.status) return false;
  if (query.source && sourceOf(row) !== query.source) return false;
  if (query.tag && !parseJson<string[]>(row.tags, []).includes(query.tag)) return false;
  return true;
}

/** 与 `list()` 逐字对齐的子串过滤（名称/描述/分类/一级词/标签），共用于 list_skills。 */
function matchesKeywordSubstring(row: SkillBriefRow, keyword?: string): boolean {
  const query = keyword?.trim().toLowerCase();
  if (!query) return true;
  const category = toSkillCategory(row.category ?? '');
  return [row.name, row.description ?? '', category, parentOfCategory(category) ?? '', ...parseJson<string[]>(row.tags, [])]
    .filter((field) => field !== '')
    .some((field) => field.toLowerCase().includes(query));
}

/** 给 agent 的下一步：候选唯一才允许自己往下走，不唯一就交给用户选。 */
function searchNextHint(items: SkillSearchHit[], ambiguous: boolean): string {
  if (items.length === 0) {
    return '没有候选：换更短、更口语的关键词再搜一次（如把「帮我跑一遍代码评审」缩成「代码评审」）；仍为空可调 list_skills 浏览目录（只含名称与描述）';
  }
  const top = items[0]!;
  if (ambiguous) {
    return `候选分数接近（top1=${top.score}，ambiguous=true）：把前 ${items.length} 条的名称 + 一句话描述列给用户，让用户选一个，不要自行挑定；选定后 get_skill(skill_id=...) 取正文`;
  }
  if (top.matched_on === 'name_exact') {
    return `名称全等命中「${top.name}」，可直接 get_skill(skill_id="${top.skill_id}") 取正文`;
  }
  return `最相近的是「${top.name}」（score=${top.score}，命中面=${top.matched_on}）：若与用户说法不一致，先向用户确认再 get_skill(skill_id="${top.skill_id}")`;
}

function listNextHint(total: number, offset: number, returned: number): string {
  const remaining = total - offset - returned;
  if (remaining > 0) {
    return `还有 ${remaining} 条：用 offset=${offset + returned} 继续翻页；只要正文请用 get_skill(skill_id=...)`;
  }
  return '目录已列完；要正文请用 get_skill(skill_id=...)（list_skills 不含 content/test_cases/mcp_dependencies）';
}

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- 查询

  async list(query: SkillListQuery): Promise<{ items: SkillDto[]; total: number }> {
    const where = {};
    const rows = await this.prisma.skill.findMany({ where, orderBy: { updatedAt: 'desc' } });
    const keyword = query.keyword?.toLowerCase();
    const items = rows
      .filter((row) => {
        if (query.type && row.type !== query.type) return false;
        if (query.status && row.status !== query.status) return false;
        if (query.source && toDto(row).source !== query.source) return false;
        if (keyword || query.tag) {
          const { tags } = parseSkill(row);
          if (keyword) {
            // 命中面 = 名称/描述/分类/标签四字段任一子串命中，与技能库搜索框的 placeholder
            // 逐字对齐（口径沿用原 name/description 的 toLowerCase().includes()，大小写不敏感）。
            // 0925 树化补口：分类词拼「叶子 + 所属一级」（parentOfCategory，一级兼叶子返回自身、
            // 重复无害不特判），与 web SkillPicker 的 categoryFieldText 同口径——row.category 恒为
            // 叶子，一级词不在任何行存储值里，不拼则搜「编码」「办公」等一级词服务端恒 0 条。
            // 空串必须显式跳过：category 的合法存储值含 ''（未分类，parentOfCategory('') 也落
            // null→''），历史 tags 里也存得出 ''，让它们进命中面就等于「未分类」被任意关键词
            // 命中——搜什么都退化成全量。
            const hit = [row.name, row.description, row.category, parentOfCategory(row.category) ?? '', ...tags]
              .filter((field) => field !== '')
              .some((field) => field.toLowerCase().includes(keyword));
            if (!hit) return false;
          }
          if (query.tag && !tags.includes(query.tag)) return false;
        }
        return true;
      })
      .map(toDto);
    return { items, total: items.length };
  }

  /**
   * 发现面列表（`list_skills`）：只回精简目录，正文一律走 `get_skill`。
   *
   * 关键字过滤沿用 `list()` 的子串口径（与 UI 搜索框逐字一致），不做模糊打分——
   * 「按意图找技能」是 `searchBrief` 的职责。两个工具各管一件事，agent 才不会选错。
   */
  async listBrief(query: SkillListQuery, limit = 50, offset = 0): Promise<SkillBriefListResult> {
    const rows = await this.prisma.skill.findMany({
      select: SKILL_BRIEF_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
    const matched = rows.filter(
      (row) => matchesMetaFilter(row, query) && matchesKeywordSubstring(row, query.keyword),
    );
    const page = matched.slice(offset, offset + limit);
    return {
      items: page.map(toBrief),
      total: matched.length,
      returned: page.length,
      limit,
      offset,
      next: listNextHint(matched.length, offset, page.length),
    };
  }

  /**
   * 意图 → 候选（`search_skills`）：**永远给候选，不给空数组**。
   *
   * 用户说的是「帮我做代码评审」，库里可能叫「代码审查」或 `code-review`：子串匹配在这种
   * 场景恒 0 命中，agent 于是无路可走、只能让人回平台翻技能库。这里改成打分排序 + 近义兜底，
   * 并把「分不出来就让用户选」写成返回值里的 `ambiguous` / `next`，而不是靠提示词自觉。
   */
  async searchBrief(query: SkillListQuery, limit = 8): Promise<SkillSearchResult> {
    const rows = await this.prisma.skill.findMany({
      select: SKILL_BRIEF_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
    const keyword = query.keyword?.trim() ?? '';
    const hits: SkillSearchHit[] = rows
      .filter((row) => matchesMetaFilter(row, query))
      .map((row) => ({ row, ...scoreCandidate(row, keyword) }))
      .filter((hit) => hit.score > 0)
      // 同分保持 findMany 的 updatedAt desc（Array#sort 稳定）——最近维护的先出现。
      .sort((left, right) => right.score - left.score)
      .map(({ row, score, matched_on }) => ({ ...toBrief(row), score, matched_on }));
    const items = hits.slice(0, limit);
    // 分差 < 15 视为「分不出来」：ambiguous 是契约级硬信号，agent 必须把候选交给用户选。
    const ambiguous = items.length > 1 && items[0]!.score - items[1]!.score < 15;
    return {
      items,
      total: hits.length,
      returned: items.length,
      ambiguous,
      next: searchNextHint(items, ambiguous),
    };
  }

  /** `get_skill(skill_name)` 的解析：名称全等、大小写不敏感；重名全部返回，由调用方决定怎么问。 */
  async findByName(name: string): Promise<SkillBriefDto[]> {
    const query = name.trim().toLowerCase();
    if (!query) return [];
    const rows = await this.prisma.skill.findMany({
      select: SKILL_BRIEF_SELECT,
      orderBy: { updatedAt: 'desc' },
    });
    return rows.filter((row) => row.name.toLowerCase() === query).map(toBrief);
  }

  /** 详情：Skill + 版本摘要 + 绑定任务数（8.2）。 */
  async detail(id: string): Promise<SkillDto> {
    const row = await this.require(id);
    const versions = await this.prisma.skillVersion.findMany({
      where: { skillId: id },
      orderBy: [{ createdAt: 'desc' }, { version: 'desc' }],
    });
    const summaries: SkillVersionSummary[] = versions.map((version) => ({
      version: version.version,
      changelog: version.changelog,
      created_at: toIso(version.createdAt),
      current: version.version === row.currentVersion,
    }));
    return {
      ...toDto(row),
      versions: summaries,
      stats: { bound_task_count: await this.boundTaskCount(id) },
    };
  }

  /** 契约补充：详情抽屉「绑定任务」Tab（skills JSON LIKE 粗筛 + Node 侧精确过滤）。 */
  async boundTasks(
    id: string,
  ): Promise<{ items: { id: string; title: string; status: string }[]; total: number }> {
    await this.require(id);
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; title: string; status: string; skills: string }[]>(
      `SELECT id, title, status, skills FROM tasks
       WHERE skills LIKE ? ORDER BY created_at DESC`,
      `%"${id}"%`,
    );
    const items = rows
      .filter((row) => parseJson<TaskSkillRef[]>(row.skills, []).some((ref) => ref.skill_id === id))
      .map((row) => ({ id: row.id, title: row.title, status: row.status }));
    return { items, total: items.length };
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 建技能。W2 r2（§9.2）：name 允许重名、不再查重，唯一性由 id（主键）保证。
   * origin：UI 直接创建=custom，导入=imported；presetId 仅用于「带 id 的导入文件
   * 且库内无同 ID」——id 终身不变，导出→分享→导入按同 id 归一（§9.9）。
   */
  async create(
    input: SkillCreateInput,
    origin: SkillOrigin = 'custom',
    presetId?: string,
  ): Promise<SkillDto> {
    const skill = await this.prisma.skill.create({
      data: {
        id: presetId ?? `skl_${uuidv7()}`,
        name: input.name,
        type: input.type,
        status: 'DRAFT',
        description: input.description,
        // §9.2 两字段两语义：category 单值分类直落列（zod 词表校验/import 侧已归一），
        // tags 是纯自由标签——0925 拍板二：create/patch 写入侧同样过 freeTagsOf 洗
        // （剔作废受众词与一切词表分类词，其余原序保留），与 0016 存量洗数、两条导入
        // 路径三方同源。只洗 tags，不碰 category 校验（越表 422 面语义不变）。
        category: input.category,
        tags: JSON.stringify(freeTagsOf(input.tags)),
        currentVersion: INITIAL_VERSION,
        content: JSON.stringify(input.content),
        testCases: JSON.stringify(input.test_cases ?? []),
        mcpDependencies: JSON.stringify(input.mcp_dependencies),
        sourceType: origin,
      },
    });
    // 创建即 v0.1.0：versions 里同步落一条，发布/回滚都从这条起步。
    await this.prisma.skillVersion.create({
      data: {
        id: `slv_${uuidv7()}`,
        skillId: skill.id,
        version: INITIAL_VERSION,
        content: skill.content,
        testCases: skill.testCases,
        mcpDependencies: skill.mcpDependencies,
        changelog: '初始版本',
      },
    });
    return toDto(skill);
  }

  /** PATCH：基础字段 + status；content 只写 skills 当前草稿，不动 versions（8.2 口径）。 */
  async patch(id: string, input: SkillPatchInput): Promise<SkillDto> {
    const row = await this.require(id);
    this.assertWritable(row, '默认技能不可编辑');
    // ③ 子技能引用环拦截：改到 content 时先做图检测，再落库。
    if (input.content !== undefined) await this.assertSkillRefsAcyclic(id, input.content);
    const data: Record<string, string> = { updatedAt: nowSql() };
    // r2（§16.2）：重名不再受限，改名不查重。
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    // 分类两态：不传=不改；传 ''=显式改未分类（0015 起 '' 是合法落库值，不能按 falsy 跳过）。
    if (input.category !== undefined) data.category = input.category;
    // 0925 拍板二：tags 整体覆盖前先过 freeTagsOf（同 create，只洗 tags 不动 category 校验）。
    if (input.tags !== undefined) data.tags = JSON.stringify(freeTagsOf(input.tags));
    if (input.status !== undefined) data.status = input.status;
    if (input.content !== undefined) data.content = JSON.stringify(input.content);
    // 8.6：测试用例只写当前草稿，与 content 同口径；发布时随版本快照。
    if (input.test_cases !== undefined) data.testCases = JSON.stringify(input.test_cases);
    await this.prisma.skill.update({ where: { id }, data });
    return this.detail(id);
  }

  /** DELETE：默认技能拒删（§9.1）；有绑定任务时 409，提示先解绑。 */
  async remove(id: string): Promise<void> {
    const row = await this.require(id);
    this.assertWritable(row, '默认技能不可删除');
    const bound = await this.boundTaskCount(id);
    if (bound > 0) {
      throw new ApiException('SKILL_BOUND', `该技能仍被 ${bound} 个任务绑定，请先解绑`, undefined, {
        bound_task_count: bound,
      });
    }
    await this.prisma.skill.delete({ where: { id } });
  }

  /** 发布（8.4）：semver patch 自增，写 version 记录并更新 current/content/mcp_dependencies。 */
  async createVersion(
    id: string,
    input: SkillVersionCreateInput,
  ): Promise<SkillDto> {
    const row = await this.require(id);
    // §9.6：仅自定义/三方技能有版本；默认技能无版本历史。
    this.assertWritable(row, '默认技能无版本管理');
    // ③ 子技能引用环拦截：发布携带的内容同样先验图。
    await this.assertSkillRefsAcyclic(id, input.content);
    const version = nextPatchVersion(row.currentVersion);
    const parsed = parseSkill(row);
    const deps = input.mcp_dependencies ?? parsed.mcpDependencies;
    // 8.6：测试用例随版本快照；入参缺省沿用技能当前草稿的 test_cases。
    const testCases = input.test_cases ?? parsed.testCases;
    await this.prisma.$transaction([
      this.prisma.skillVersion.create({
        data: {
          id: `slv_${uuidv7()}`,
          skillId: id,
          version,
          content: JSON.stringify(input.content),
          testCases: JSON.stringify(testCases),
          mcpDependencies: JSON.stringify(deps),
          changelog: input.changelog,
        },
      }),
      this.prisma.skill.update({
        where: { id },
        data: {
          currentVersion: version,
          content: JSON.stringify(input.content),
          testCases: JSON.stringify(testCases),
          mcpDependencies: JSON.stringify(deps),
          updatedAt: nowSql(),
        },
      }),
    ]);
    return this.detail(id);
  }

  /**
   * v0.0.4 W3 §9.6：单版本快照——编辑器「版本历史 / 与当前对比」按需拉取。
   * 只读接口不触发 SKILL_READONLY 守卫；默认技能无版本记录，查不到即 404。
   */
  async versionSnapshot(id: string, version: string): Promise<SkillVersionSnapshotDto> {
    await this.require(id);
    const target = await this.prisma.skillVersion.findUnique({
      where: { skillId_version: { skillId: id, version } },
    });
    if (!target) {
      throw new ApiException('NOT_FOUND', `版本 ${version} 不存在`, undefined, { version });
    }
    return {
      version: target.version,
      changelog: target.changelog,
      created_at: toIso(target.createdAt),
      content: JSON.parse(target.content) as SkillContent,
      mcp_dependencies: JSON.parse(target.mcpDependencies) as SkillMcpDependency[],
    };
  }

  /** 8.4 回滚：复制该版本内容/依赖/测试用例为 current，不新增 version 记录。默认技能拒回滚。 */
  async rollback(id: string, version: string): Promise<SkillDto> {
    const row = await this.require(id);
    this.assertWritable(row, '默认技能无版本管理');
    const target = await this.prisma.skillVersion.findUnique({
      where: { skillId_version: { skillId: id, version } },
    });
    if (!target) {
      throw new ApiException('NOT_FOUND', `版本 ${version} 不存在`, undefined, { version });
    }
    await this.prisma.skill.update({
      where: { id },
      data: {
        currentVersion: version,
        content: target.content,
        testCases: target.testCases,
        mcpDependencies: target.mcpDependencies,
        updatedAt: nowSql(),
      },
    });
    return this.detail(id);
  }

  /** 8.5 测试运行（旧形态）：从 entryBlockId 沿 next 走，human 视为 blocked；script 等不执行。 */
  async test(id: string, input: string): Promise<SkillTestResult> {
    const row = await this.require(id);
    const parsed = parseSkill(row);
    // 8.6：有测试用例时逐个运行，human 块按 blocked 计（该用例不通过）。
    if (parsed.testCases.length > 0) {
      const results = parsed.testCases.map((testCase) => {
        const run = runFlow(parsed.content, testCaseInputText(testCase.input));
        return {
          case_id: testCase.id,
          name: testCase.name,
          ok: run.ok,
          logs: run.logs,
          output: run.output,
        };
      });
      return {
        mode: 'cases',
        results,
        passed: results.filter((item) => item.ok).length,
        total: results.length,
      };
    }
    const run = runFlow(parsed.content, input);
    return run.blocked
      ? { mode: 'single', ok: false, logs: run.logs, output: run.output, blocked: run.blocked }
      : { mode: 'single', ok: true, logs: run.logs, output: run.output };
  }

  // ---------------------------------------------------------------- 导出/导入

  async export(id: string, res: Response): Promise<void> {
    const row = await this.require(id);
    const parsed = parseSkill(row);
    // 文件名只用 ASCII 安全字符，非 ASCII（中文技能名）回退到 skill id。
    const safeName = /^[\w.-]+$/.test(row.name) ? row.name : row.id;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.atskill"`);
    const payload = {
      // r2（§9.9）：导出必带 id——分享再导入按同 id 识别为同一技能，形成闭环。
      id: row.id,
      name: row.name,
      type: row.type,
      content: parsed.content,
      version: row.currentVersion,
      test_cases: parsed.testCases,
      mcp_dependencies: parsed.mcpDependencies,
      description: row.description,
      tags: parsed.tags,
      // §9.2：单值分类随导出包走（SKILL.md frontmatter 与 .atskill 同源同列）。
      category: row.category,
      source: row.sourceType,
      exported_at: new Date().toISOString(),
    };
    res.send(JSON.stringify(payload));
  }

  /**
   * 导入 .atskill（multipart，字段 file）：解析后建新三方技能 v0.1.0 DRAFT。
   * W2 r2（§9.8.4）：冲突按文件 `id` 判定（同名不是冲突、直接共存）——
   * 同 ID 且库内已存在时按 on_conflict 处置：fail=409（UI 拿 detail 再问用户）、
   * overwrite=覆盖更新（记为新版本）、skip=不动原技能返回既有行。
   */
  async import(
    file: { buffer?: Buffer; originalname?: string } | undefined,
    onConflict: 'fail' | 'overwrite' | 'skip' = 'fail',
  ): Promise<SkillDto> {
    if (!file?.buffer?.length) {
      throw new ApiException('VALIDATION_FAILED', '缺少 file 字段（multipart 单文件）', [
        { path: 'file', code: 'missing_file', message: '需要一个 .atskill 文件' },
      ]);
    }
    if (file.buffer.length > SKILL_IMPORT_MAX_BYTES) {
      throw new ApiException('VALIDATION_FAILED', '技能文件超过 1MB 上限');
    }
    let payload: {
      id?: unknown;
      name?: unknown;
      type?: unknown;
      content?: unknown;
      test_cases?: unknown;
      mcp_dependencies?: unknown;
      mcpDependencies?: unknown;
      description?: unknown;
      tags?: unknown;
      category?: unknown;
    };
    try {
      payload = JSON.parse(file.buffer.toString('utf8'));
    } catch {
      throw new ApiException('VALIDATION_FAILED', '技能文件不是合法 JSON');
    }
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      throw new ApiException('VALIDATION_FAILED', '技能文件缺少 name 字段');
    }
    if (typeof payload.type !== 'string') {
      throw new ApiException('VALIDATION_FAILED', '技能文件缺少 type 字段');
    }
    const deps = (payload.mcp_dependencies ?? payload.mcpDependencies ?? []) as SkillMcpDependency[];
    // §9.2 导入归一（与 SKILL.md 路径同口径）：category 词表外落 ''（旧包无此字段即未分类）；
    // tags 按 0016 口径剔受众词与一切词表词（0925 拍板收紧），其余原序保留。
    const category = toSkillCategory(payload.category);
    const rawTags = Array.isArray(payload.tags) ? (payload.tags as string[]).map(String) : [];
    const data = {
      name: payload.name.trim(),
      type: payload.type as SkillType,
      description: typeof payload.description === 'string' ? payload.description : '',
      category,
      tags: freeTagsOf(rawTags).filter((tag) => tag.length > 0 && tag.length <= 30),
      content: (payload.content ?? EMPTY_CONTENT) as SkillContent,
      // 8.6：测试用例随 .atskill 一起带走（旧文件没有该字段就是空）。
      test_cases: Array.isArray(payload.test_cases) ? (payload.test_cases as SkillTestCase[]) : [],
      mcp_dependencies: deps,
    };
    const fileId = this.normalizeFileId(payload.id);
    const existing = fileId ? await this.prisma.skill.findUnique({ where: { id: fileId } }) : null;
    if (existing) return this.applyIdConflict(existing, data, onConflict);
    return this.create(data, 'imported', fileId ?? undefined);
  }

  /**
   * SKILL.md / Cursor Rules（.mdc）导入：JSON {filename, content}。
   * frontmatter 元数据头（.mdc 同样是 frontmatter，剥掉即可）提供
   * id/name/description/version/category/tags/mcp_dependencies；正文块解析约定与前端
   * markdown.ts 的 markdownToBlocks 完全一致（api 侧镜像见 skill-markdown.ts）。
   * 结果：新三方技能 v0.1.0 DRAFT；同名直接共存，同 ID 按 on_conflict 处置（r2）。
   */
  async importMarkdown(
    input: SkillImportMarkdownInput,
    onConflict: 'fail' | 'overwrite' | 'skip' = 'fail',
  ): Promise<SkillDto> {
    const parsed = markdownToBlocks(input.content);
    const fm = parsed.frontmatter;
    const baseName =
      fm?.name?.trim() ||
      input.filename.replace(/\.(md|markdown|mdc)$/i, '').trim() ||
      '导入技能';
    if (parsed.content.blocks.length === 0) {
      // 无 ### 小节：整体作提示词块（与前端「无小节正文」约定一致，服务端兜底同一条）。
      const body = parseFrontmatter(input.content).body.trim();
      if (!body) {
        throw new ApiException('VALIDATION_FAILED', '文件内容为空，没有可导入的块', [
          { path: 'content', code: 'empty_content', message: '正文为空' },
        ]);
      }
      const block = {
        id: 'block-import-0',
        kind: 'prompt',
        title: baseName,
        prompt: body,
      };
      parsed.content = { blocks: [block as SkillContent['blocks'][number]], entryBlockId: 'block-import-0' };
    }
    // §9.2 分类收口（0015）：frontmatter `category` 直落 skills.category 列，词表外值
    // （含旧导出包把 category 写成 workflow/flow 类型枚举值的文件）归未分类 ''、不报错。
    // 旧实现「category 没有对应列、折进标签」的行为连同 .mdc 共用路径一并作废——
    // tags 退回纯自由标签，按 0016 口径剔受众词与一切词表词（0925 拍板收紧），其余原序保留。
    const category = toSkillCategory(fm?.category);
    const tags = freeTagsOf(fm?.tags ?? []).filter((tag) => tag.length <= 30);
    const data: SkillCreateInput = {
      name: baseName,
      // 只有一个提示词块 → prompt 技能，否则按流程技能处理。
      type: parsed.content.blocks.length === 1 && parsed.content.blocks[0].kind === 'prompt'
        ? 'prompt'
        : 'flow',
      description: fm?.description ?? '',
      category,
      tags: tags.slice(0, 20),
      content: parsed.content,
      test_cases: [] as SkillTestCase[],
      mcp_dependencies: (fm?.mcpDependencies ?? []) as SkillMcpDependency[],
    };
    const fileId = this.normalizeFileId(fm?.id);
    const existing = fileId ? await this.prisma.skill.findUnique({ where: { id: fileId } }) : null;
    if (existing) return this.applyIdConflict(existing, data, onConflict);
    return this.create(data, 'imported', fileId ?? undefined);
  }

  // ---------------------------------------------------------------- SKILL.md 导入导出（8.7）

  /** SKILL.md 导出：text/markdown 附件（name.md），约定同前端 blocksToMarkdown；frontmatter 必带 id（r2）。 */
  async exportMarkdown(id: string, res: Response): Promise<void> {
    const row = await this.require(id);
    const parsed = parseSkill(row);
    const markdown = blocksToMarkdown(parsed.content, {
      id: row.id,
      name: row.name,
      description: row.description.replace(/\n/g, ' '),
      version: row.currentVersion,
      // §9.2：frontmatter category 与 skills.category 列一一对应——导出取真实列值，
      // 不再硬编码 ''（旧口径没有列，值全靠前端把 type/猜测塞进来，本棒起作废）。
      category: row.category,
      tags: parsed.tags,
      mcpDependencies: parsed.mcpDependencies,
    });
    const safeName = /^[\w.-]+$/.test(row.name) ? row.name : row.id;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.md"`);
    res.send(markdown);
  }

  // ---------------------------------------------------------------- 技能源（8.8）

  /** GET /skills/sources：settings kv 存 JSON 数组；builtin 缺条目时动态补一条（不落库）。 */
  async listSources(): Promise<(SkillSource & { unavailable?: boolean })[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: SKILL_SOURCES_SETTING_KEY } });
    const stored = parseJson<SkillSource[]>(row?.value, []).filter(
      (source): source is SkillSource =>
        !!source && typeof source.id === 'string' && typeof source.type === 'string',
    );
    const sources = stored.some((source) => source.type === 'builtin')
      ? stored
      : [BUILTIN_SOURCE, ...stored];
    return sources.map((source) =>
      LEGACY_SOURCE_TYPES.includes(source.type) ? { ...source, unavailable: true } : source,
    );
  }

  /** PUT /skills/sources：整表覆盖写 kv（body 就是完整数组，PUT 语义）。 */
  async saveSources(sources: SkillSource[]): Promise<SkillSource[]> {
    await this.prisma.setting.upsert({
      where: { key: SKILL_SOURCES_SETTING_KEY },
      create: { key: SKILL_SOURCES_SETTING_KEY, value: JSON.stringify(sources) },
      update: { value: JSON.stringify(sources), updatedAt: nowSql() },
    });
    return this.listSources();
  }

  /** POST /skills/sources/scan：directory 源扫描 *.atskill / *.md / *.mdc。 */
  async scanSource(sourceId: string): Promise<{ source: SkillSource; items: ReturnType<typeof scanDirectory> }> {
    const sources = await this.listSources();
    const source = sources.find((row) => row.id === sourceId);
    if (!source) throw new ApiException('NOT_FOUND', '技能源不存在', undefined, { source_id: sourceId });
    if (LEGACY_SOURCE_TYPES.includes(source.type)) {
      throw new ApiException('NOT_IMPLEMENTED', '第三方远程源暂未开放');
    }
    if (source.type === 'builtin') {
      // 内置源随安装包预置，不走文件系统扫描。
      return { source, items: [] };
    }
    return { source, items: scanDirectory(source.path) };
  }

  // ---------------------------------------------------------------- 任务绑定（10.3）

  /**
   * PATCH /tasks/:id 的 skills 校验：skill 存在、version 可解析（缺省用 current）。
   * 返回补全 version 后的 JSON 串（存库口径：引用始终带显式版本，下发时不用再猜）。
   *
   * 「可解析」的判据必须与下发侧 resolveForTask 同源，而不是「非版本表不可」：
   * §9.6 明文默认技能无版本历史，ensureDefaultSkills 只写 skills 行、不写 skill_versions，
   * 其 currentVersion='builtin' 因此在版本表里查无此行。按旧判据这等于禁止绑定任何内置技能
   * ——随包 125 条首装即全部命中（422 unknown_version，客户端表现为选技能就 toast 报错），
   * 而下发链路本来就能把这条引用解析成技能行的当前内容。
   */
  async normalizeTaskBindings(refs: TaskSkillRef[]): Promise<string> {
    const resolved: TaskSkillRef[] = [];
    for (const ref of refs) {
      const skill = await this.prisma.skill.findUnique({
        where: { id: ref.skill_id },
        select: { id: true, currentVersion: true, versions: { select: { version: true } } },
      });
      if (!skill) {
        throw new ApiException('VALIDATION_FAILED', `技能 ${ref.skill_id} 不存在`, [
          { path: 'skills', code: 'unknown_skill', message: ref.skill_id },
        ]);
      }
      const version = ref.version ?? skill.currentVersion;
      const resolvable = version === skill.currentVersion || skill.versions.some((row) => row.version === version);
      if (!resolvable) {
        throw new ApiException(
          'VALIDATION_FAILED',
          `技能 ${ref.skill_id} 不存在版本 ${version}`,
          [{ path: 'skills', code: 'unknown_version', message: `${ref.skill_id}@${version}` }],
        );
      }
      resolved.push({ skill_id: ref.skill_id, version });
    }
    return JSON.stringify(resolved);
  }

  /** Agent 下发（10.3）：把绑定 JSON 解析成带内容/依赖/版本的载荷；失效引用跳过不炸整个任务。 */
  async resolveForTask(skillsJson: string | null): Promise<TaskSkillPayload[]> {
    const refs = parseJson<TaskSkillRef[]>(skillsJson, []);
    if (refs.length === 0) return [];
    const payloads = await Promise.all(
      refs.map(async (ref): Promise<TaskSkillPayload | null> => {
        const skill = await this.prisma.skill.findUnique({
          where: { id: ref.skill_id },
          include: { versions: true },
        });
        if (!skill) return null;
        const parsed = parseSkill(skill);
        // 绑定引用始终带显式版本（normalizeTaskBindings 补全过）；版本记录被删等极端情况回落当前草稿。
        const version = ref.version ?? skill.currentVersion;
        const versionRow = skill.versions.find((row) => row.version === version);
        return {
          skill_id: skill.id,
          version,
          name: skill.name,
          type: skill.type as SkillType,
          status: skill.status as SkillStatus,
          content: versionRow ? parseJson<SkillContent>(versionRow.content, parsed.content) : parsed.content,
          mcp_dependencies: versionRow
            ? parseJson<SkillMcpDependency[]>(versionRow.mcpDependencies, parsed.mcpDependencies)
            : parsed.mcpDependencies,
        };
      }),
    );
    return payloads.filter((payload): payload is TaskSkillPayload => payload !== null);
  }

  // ---------------------------------------------------------------- 内部

  private async require(id: string): Promise<Skill> {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', '技能不存在');
    return row;
  }

  /** §9.1 默认技能只读：改/删/发版统一守卫（readonly 由 source==='default' 推导）。 */
  private assertWritable(row: Skill, what: string): void {
    if (toDto(row).readonly) {
      throw new ApiException('SKILL_READONLY', `${what}（内置默认技能，随应用包更新）`, undefined, {
        skill_id: row.id,
      });
    }
  }

  /**
   * ③ 技能引用环守卫：把「待写入的这份内容」当作 id 节点的最新出边，叠加库内其余技能的
   * 子技能出边构成引用图，检出（a）直接自引用 id→id，（b）经其它技能回到 id 的环。
   * 命中即抛 SKILL_REF_SELF(400) / SKILL_REF_CYCLE(409)（码在 contract/errors.ts，检测在 skill-reference.ts）。
   */
  private async assertSkillRefsAcyclic(id: string, content: SkillContent): Promise<void> {
    const outRefs = subskillRefs(content);
    if (outRefs.includes(id)) {
      throw new ApiException(
        'SKILL_REF_SELF',
        '技能不能被子技能块引用自身（skillRef 指向自己）',
        undefined,
        { skill_id: id },
      );
    }
    if (outRefs.length === 0) return; // 无子技能出边 → 不可能经本节点成环，省一次全表读。
    // 其余节点用库内当前 content 的出边；本节点覆盖为待写入出边（草稿尚未落库）。
    const rows = await this.prisma.skill.findMany({ select: { id: true, content: true } });
    const edges = new Map<string, string[]>(
      rows.map((row) => [row.id, subskillRefsOfJson(row.content)]),
    );
    edges.set(id, outRefs);
    const chain = findSkillRefCycle(edges, id);
    if (chain) {
      throw new ApiException(
        'SKILL_REF_CYCLE',
        `技能子技能引用形成环：${chain.join(' → ')}，已拒绝`,
        undefined,
        { skill_id: id, chain },
      );
    }
  }

  /** 导入文件里的 id：仅接受非空短字符串；坏值按无 id 处理（新分配，不炸导入）。 */
  private normalizeFileId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
  }

  /** 同 ID 冲突处置（§9.8.4）：fail=409 / skip=原样返回 / overwrite=覆盖并记新版本。 */
  private async applyIdConflict(
    existing: Skill,
    data: SkillCreateInput,
    onConflict: 'fail' | 'overwrite' | 'skip',
  ): Promise<SkillDto> {
    if (onConflict === 'skip') return toDto(existing);
    if (onConflict === 'fail') {
      throw new ApiException(
        'SKILL_ID_CONFLICT',
        `技能 ${existing.id}（「${existing.name}」）已存在：请选择覆盖更新或跳过`,
        undefined,
        { skill_id: existing.id, name: existing.name, current_version: existing.currentVersion },
      );
    }
    this.assertWritable(existing, '默认技能不可被导入覆盖');
    // 覆盖更新为新版本（§20.5-17）：semver patch 自增 + 版本快照，同 createVersion 口径。
    const version = nextPatchVersion(existing.currentVersion);
    await this.prisma.$transaction([
      this.prisma.skillVersion.create({
        data: {
          id: `slv_${uuidv7()}`,
          skillId: existing.id,
          version,
          content: JSON.stringify(data.content),
          testCases: JSON.stringify(data.test_cases ?? []),
          mcpDependencies: JSON.stringify(data.mcp_dependencies),
          changelog: '导入覆盖更新',
        },
      }),
      this.prisma.skill.update({
        where: { id: existing.id },
        data: {
          name: data.name,
          description: data.description,
          // 覆盖导入同样覆盖分类（data.category 已在两条导入路径归一为词表值或 ''）。
          category: data.category,
          tags: JSON.stringify(data.tags),
          content: JSON.stringify(data.content),
          testCases: JSON.stringify(data.test_cases ?? []),
          mcpDependencies: JSON.stringify(data.mcp_dependencies),
          currentVersion: version,
          updatedAt: nowSql(),
        },
      }),
    ]);
    return this.detail(existing.id);
  }

  private async boundTaskCount(id: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ count: number | bigint }[]>(
      `SELECT COUNT(*) AS count FROM tasks WHERE skills LIKE ?`,
      `%"${id}"%`,
    );
    return Number(rows[0]?.count ?? 0);
  }
}

/** 8.6 用例的 input 是 passthrough JSON：字符串直接用，其余 JSON 序列化成模拟输入。 */
function testCaseInputText(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/**
 * 8.5 模拟运行：从 entryBlockId 沿 next 走，prompt/step 拼接文本；
 * human 块按 blocked 中断（8.4 测试口径：human 视为 blocked）；script 等本地不执行。
 * 8.3 的 15 类块都认识：与执行无关的类型只记日志不产出。
 */
function runFlow(
  content: SkillContent,
  input: string,
): { ok: boolean; logs: string[]; output: string; blocked?: { blockId: string; instruction: string } } {
  type Block = SkillContent['blocks'][number];
  const byId = new Map(content.blocks.map((block) => [block.id, block]));
  const logs: string[] = [];
  const parts: string[] = [];
  if (input) logs.push(`输入: ${input}`);
  if (content.entryBlockId && !byId.has(content.entryBlockId)) {
    logs.push(`入口块 ${content.entryBlockId} 不存在，从头遍历`);
  }
  let current: string | null =
    content.entryBlockId && byId.has(content.entryBlockId)
      ? content.entryBlockId
      : (content.blocks[0]?.id ?? null);
  const visited = new Set<string>();
  let blocked: { blockId: string; instruction: string } | undefined;

  while (current && !blocked) {
    if (visited.has(current)) {
      logs.push(`检测到环：块 ${current} 重复到达，测试终止`);
      break;
    }
    visited.add(current);
    const block: Block = byId.get(current)!;
    logs.push(`[${block.kind}] ${block.title || block.id}`);
    switch (block.kind) {
      case 'prompt':
      case 'knowledge':
        if (block.prompt) parts.push(block.prompt);
        break;
      case 'step':
        for (const step of block.steps ?? []) parts.push(step);
        break;
      case 'human':
        blocked = {
          blockId: block.id,
          instruction: block.humanInstruction || block.prompt || '该块需要人工处理',
        };
        logs.push(`需人工处理：${blocked.instruction}`);
        continue;
      case 'script':
        logs.push('本地不执行脚本（桌面端测试环境）');
        break;
      case 'decision':
        // 条件在测试环境无法求值：按第一个分支走并记录。
        logs.push(`条件「${block.condition ?? ''}」无法在测试环境求值，按第一个分支继续`);
        break;
      case 'loop':
        logs.push(`循环「${block.while ?? ''}」在测试环境按单次执行`);
        break;
      case 'parallel':
        logs.push(`并行块（合并 ${block.merge ?? 'all'}）在测试环境按顺序模拟`);
        break;
      case 'tool':
        logs.push(`调用 MCP 工具 ${block.tool ?? '（未指定）'}：测试环境跳过`);
        break;
      case 'subskill':
        logs.push(`引用技能 ${block.skillRef ?? '（未指定）'}：测试环境不展开`);
        break;
      case 'input':
      case 'output':
        logs.push(`${block.kind === 'input' ? '输入' : '输出'}变量 ${block.name ?? '（未命名）'}（${block.valueType ?? 'string'}）`);
        break;
      case 'constraint':
        logs.push(`规则：${block.rule ?? ''}`);
        break;
      case 'error_handler':
        logs.push(`失败策略 ${block.onError ?? 'abort'}：测试环境不注入错误`);
        break;
      case 'comment':
        break;
    }
    const nexts: Block['next'] = block.next ?? [];
    if (nexts.length === 0) break;
    const picked = nexts[0]!;
    logs.push(`→ 分支「${picked.when}」`);
    if (!picked.to) {
      logs.push('该分支为终态（无跳转），测试结束');
      break;
    }
    current = byId.has(picked.to) ? picked.to : null;
    if (!current) logs.push(`分支目标 ${picked.to} 不存在，测试终止`);
  }

  const output = parts.join('\n\n');
  return { ok: !blocked, logs, output, blocked };
}
