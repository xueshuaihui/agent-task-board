import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import type { Skill, SkillVersion } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import {
  LEGACY_SOURCE_TYPES,
  nextPatchVersion,
  parseJson,
  type SkillContent,
  type SkillCreateInput,
  type SkillDto,
  type SkillImportMarkdownInput,
  type SkillListQuery,
  type SkillMcpDependency,
  type SkillPatchInput,
  type SkillSource,
  type SkillStatus,
  type SkillTestCase,
  type SkillTestResult,
  type SkillType,
  type SkillVersionCreateInput,
  type SkillVersionSummary,
  type TaskSkillPayload,
  type TaskSkillRef,
} from './skills.dto';
import { blocksToMarkdown, markdownToBlocks, parseFrontmatter } from './skill-markdown';
import { scanDirectory } from './skill-sources';

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
  return {
    id: row.id,
    name: row.name,
    type: row.type as SkillType,
    status: row.status as SkillStatus,
    description: row.description,
    tags: parsed.tags,
    current_version: row.currentVersion,
    content: parsed.content,
    test_cases: parsed.testCases,
    mcp_dependencies: parsed.mcpDependencies,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
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
        if (keyword) {
          const hit =
            row.name.toLowerCase().includes(keyword) || row.description.toLowerCase().includes(keyword);
          if (!hit) return false;
        }
        if (query.tag && !parseSkill(row).tags.includes(query.tag)) return false;
        return true;
      })
      .map(toDto);
    return { items, total: items.length };
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

  async create(input: SkillCreateInput): Promise<SkillDto> {
    // 名称唯一约束在库上（uniq_skills_name，W1a 去账号维度后的单列唯一）；这里先给出人话错误而不是 P2002。
    const dup = await this.prisma.skill.findFirst({ where: { name: input.name } });
    if (dup) throw new ApiException('SKILL_NAME_TAKEN', `技能名「${input.name}」已存在`);
    const skill = await this.prisma.skill.create({
      data: {
        id: `skl_${uuidv7()}`,
        name: input.name,
        type: input.type,
        status: 'DRAFT',
        description: input.description,
        tags: JSON.stringify(input.tags),
        currentVersion: INITIAL_VERSION,
        content: JSON.stringify(input.content),
        testCases: JSON.stringify(input.test_cases ?? []),
        mcpDependencies: JSON.stringify(input.mcp_dependencies),
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
    const data: Record<string, string> = { updatedAt: nowSql() };
    if (input.name !== undefined) {
      if (input.name !== row.name) {
        const dup = await this.prisma.skill.findFirst({ where: { name: input.name } });
        if (dup) throw new ApiException('SKILL_NAME_TAKEN', `技能名「${input.name}」已存在`);
      }
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.tags !== undefined) data.tags = JSON.stringify(input.tags);
    if (input.status !== undefined) data.status = input.status;
    if (input.content !== undefined) data.content = JSON.stringify(input.content);
    // 8.6：测试用例只写当前草稿，与 content 同口径；发布时随版本快照。
    if (input.test_cases !== undefined) data.testCases = JSON.stringify(input.test_cases);
    await this.prisma.skill.update({ where: { id }, data });
    return this.detail(id);
  }

  /** DELETE：有绑定任务时 409，提示先解绑。 */
  async remove(id: string): Promise<void> {
    await this.require(id);
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

  /** 8.4 回滚：复制该版本内容/依赖/测试用例为 current，不新增 version 记录。 */
  async rollback(id: string, version: string): Promise<SkillDto> {
    await this.require(id);
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
      name: row.name,
      type: row.type,
      content: parsed.content,
      version: row.currentVersion,
      test_cases: parsed.testCases,
      mcp_dependencies: parsed.mcpDependencies,
      description: row.description,
      tags: parsed.tags,
      exported_at: new Date().toISOString(),
    };
    res.send(JSON.stringify(payload));
  }

  /** 导入 .atskill（multipart，字段 file）：解析后建新技能 v0.1.0 DRAFT，重名加后缀。 */
  async import(
    file: { buffer?: Buffer; originalname?: string } | undefined,
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
      name?: unknown;
      type?: unknown;
      content?: unknown;
      test_cases?: unknown;
      mcp_dependencies?: unknown;
      mcpDependencies?: unknown;
      description?: unknown;
      tags?: unknown;
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
    const name = await this.availableName(payload.name.trim());
    const deps = (payload.mcp_dependencies ?? payload.mcpDependencies ?? []) as SkillMcpDependency[];
    return this.create(
      {
        name,
        type: payload.type as SkillType,
        description: typeof payload.description === 'string' ? payload.description : '',
        tags: Array.isArray(payload.tags) ? (payload.tags as string[]).map(String) : [],
        content: (payload.content ?? EMPTY_CONTENT) as SkillContent,
        // 8.6：测试用例随 .atskill 一起带走（旧文件没有该字段就是空）。
        test_cases: Array.isArray(payload.test_cases) ? (payload.test_cases as SkillTestCase[]) : [],
        mcp_dependencies: deps,
      },
    );
  }

  // ---------------------------------------------------------------- SKILL.md 导入导出（8.7）

  /**
   * SKILL.md / Cursor Rules（.mdc）导入：JSON {filename, content}。
   * frontmatter 元数据头（.mdc 同样是 frontmatter，剥掉即可）提供
   * name/description/version/category/tags/mcp_dependencies；正文块解析约定与前端
   * markdown.ts 的 markdownToBlocks 完全一致（api 侧镜像见 skill-markdown.ts）。
   * 无 ### 小节时整体作一个提示词块。结果：新技能 v0.1.0 DRAFT，重名加后缀。
   */
  async importMarkdown(input: SkillImportMarkdownInput): Promise<SkillDto> {
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
    const name = await this.availableName(baseName);
    const tags = [
      ...(fm?.tags ?? []),
      // category 没有对应列，折进标签；.mdc 的 Cursor 元数据其余键随 frontmatter 剥离不导入。
      ...(fm?.category && !fm.tags.includes(fm.category) ? [fm.category] : []),
    ].filter((tag) => tag.length > 0 && tag.length <= 30);
    return this.create(
      {
        name,
        // 只有一个提示词块 → prompt 技能，否则按流程技能处理。
        type: parsed.content.blocks.length === 1 && parsed.content.blocks[0].kind === 'prompt'
          ? 'prompt'
          : 'flow',
        description: fm?.description ?? '',
        tags: tags.slice(0, 20),
        content: parsed.content,
        test_cases: [],
        mcp_dependencies: (fm?.mcpDependencies ?? []) as SkillMcpDependency[],
      },
    );
  }

  /** SKILL.md 导出：text/markdown 附件（name.md），约定同前端 blocksToMarkdown。 */
  async exportMarkdown(id: string, res: Response): Promise<void> {
    const row = await this.require(id);
    const parsed = parseSkill(row);
    const markdown = blocksToMarkdown(parsed.content, {
      name: row.name,
      description: row.description.replace(/\n/g, ' '),
      version: row.currentVersion,
      category: '',
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
   * PATCH /tasks/:id 的 skills 校验：skill 存在、version 存在（缺省用 current）。
   * 返回补全 version 后的 JSON 串（存库口径：引用始终带显式版本，下发时不用再猜）。
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
      if (!skill.versions.some((row) => row.version === version)) {
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

  private async boundTaskCount(id: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ count: number | bigint }[]>(
      `SELECT COUNT(*) AS count FROM tasks WHERE skills LIKE ?`,
      `%"${id}"%`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async availableName(name: string): Promise<string> {
    const existing = await this.prisma.skill.findMany({
      where: { name: { startsWith: name } },
      select: { name: true },
    });
    const taken = new Set(existing.map((row) => row.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i += 1) {
      const candidate = `${name} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
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
