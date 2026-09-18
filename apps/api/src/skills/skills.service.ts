import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import type { Skill, SkillVersion } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import {
  nextPatchVersion,
  parseJson,
  type SkillContent,
  type SkillCreateInput,
  type SkillDto,
  type SkillListQuery,
  type SkillMcpDependency,
  type SkillPatchInput,
  type SkillStatus,
  type SkillType,
  type SkillVersionCreateInput,
  type SkillVersionSummary,
  type TaskSkillPayload,
  type TaskSkillRef,
} from './skills.dto';

const INITIAL_VERSION = 'v0.1.0';
const EMPTY_CONTENT: SkillContent = { blocks: [], entryBlockId: null };

/** 导入文件硬顶：技能文件是几 KB 的 JSON，1MB 已经是千倍余量。 */
export const SKILL_IMPORT_MAX_BYTES = 1024 * 1024;

interface ParsedSkill {
  content: SkillContent;
  mcpDependencies: SkillMcpDependency[];
  tags: string[];
}

function parseSkill(row: Skill): ParsedSkill {
  return {
    content: parseJson<SkillContent>(row.content, EMPTY_CONTENT),
    mcpDependencies: parseJson<SkillMcpDependency[]>(row.mcpDependencies, []),
    tags: parseJson<string[]>(row.tags, []),
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
    mcp_dependencies: parsed.mcpDependencies,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- 查询

  async list(query: SkillListQuery, accountId: string): Promise<{ items: SkillDto[]; total: number }> {
    const where = { accountId };
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
  async detail(id: string, accountId: string): Promise<SkillDto> {
    const row = await this.require(id, accountId);
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
      stats: { bound_task_count: await this.boundTaskCount(id, accountId) },
    };
  }

  /** 契约补充：详情抽屉「绑定任务」Tab（skills JSON LIKE 粗筛 + Node 侧精确过滤）。 */
  async boundTasks(
    id: string,
    accountId: string,
  ): Promise<{ items: { id: string; title: string; status: string }[]; total: number }> {
    await this.require(id, accountId);
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; title: string; status: string; skills: string }[]>(
      `SELECT id, title, status, skills FROM tasks
       WHERE account_id = ? AND skills LIKE ? ORDER BY created_at DESC`,
      accountId,
      `%"${id}"%`,
    );
    const items = rows
      .filter((row) => parseJson<TaskSkillRef[]>(row.skills, []).some((ref) => ref.skill_id === id))
      .map((row) => ({ id: row.id, title: row.title, status: row.status }));
    return { items, total: items.length };
  }

  // ---------------------------------------------------------------- 写入

  async create(input: SkillCreateInput, accountId: string): Promise<SkillDto> {
    // 名称唯一约束在库上（同账号内）；这里先给出人话错误而不是 P2002。
    const dup = await this.prisma.skill.findFirst({ where: { accountId, name: input.name } });
    if (dup) throw new ApiException('SKILL_NAME_TAKEN', `技能名「${input.name}」已存在`);
    const skill = await this.prisma.skill.create({
      data: {
        id: `skl_${uuidv7()}`,
        accountId,
        name: input.name,
        type: input.type,
        status: 'DRAFT',
        description: input.description,
        tags: JSON.stringify(input.tags),
        currentVersion: INITIAL_VERSION,
        content: JSON.stringify(input.content),
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
        mcpDependencies: skill.mcpDependencies,
        changelog: '初始版本',
      },
    });
    return toDto(skill);
  }

  /** PATCH：基础字段 + status；content 只写 skills 当前草稿，不动 versions（8.2 口径）。 */
  async patch(id: string, accountId: string, input: SkillPatchInput): Promise<SkillDto> {
    const row = await this.require(id, accountId);
    const data: Record<string, string> = { updatedAt: nowSql() };
    if (input.name !== undefined) {
      if (input.name !== row.name) {
        const dup = await this.prisma.skill.findFirst({ where: { accountId, name: input.name } });
        if (dup) throw new ApiException('SKILL_NAME_TAKEN', `技能名「${input.name}」已存在`);
      }
      data.name = input.name;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.tags !== undefined) data.tags = JSON.stringify(input.tags);
    if (input.status !== undefined) data.status = input.status;
    if (input.content !== undefined) data.content = JSON.stringify(input.content);
    await this.prisma.skill.update({ where: { id }, data });
    return this.detail(id, accountId);
  }

  /** DELETE：有绑定任务时 409，提示先解绑。 */
  async remove(id: string, accountId: string): Promise<void> {
    await this.require(id, accountId);
    const bound = await this.boundTaskCount(id, accountId);
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
    accountId: string,
    input: SkillVersionCreateInput,
  ): Promise<SkillDto> {
    const row = await this.require(id, accountId);
    const version = nextPatchVersion(row.currentVersion);
    const deps = input.mcp_dependencies ?? parseSkill(row).mcpDependencies;
    await this.prisma.$transaction([
      this.prisma.skillVersion.create({
        data: {
          id: `slv_${uuidv7()}`,
          skillId: id,
          version,
          content: JSON.stringify(input.content),
          mcpDependencies: JSON.stringify(deps),
          changelog: input.changelog,
        },
      }),
      this.prisma.skill.update({
        where: { id },
        data: {
          currentVersion: version,
          content: JSON.stringify(input.content),
          mcpDependencies: JSON.stringify(deps),
          updatedAt: nowSql(),
        },
      }),
    ]);
    return this.detail(id, accountId);
  }

  /** 8.4 回滚：复制该版本内容/依赖为 current，不新增 version 记录。 */
  async rollback(id: string, accountId: string, version: string): Promise<SkillDto> {
    await this.require(id, accountId);
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
        mcpDependencies: target.mcpDependencies,
        updatedAt: nowSql(),
      },
    });
    return this.detail(id, accountId);
  }

  /** 8.5 测试运行：从 entryBlockId 沿 next 走，prompt/step 拼接文本；human 中断；script 不执行。 */
  async test(
    id: string,
    accountId: string,
    input: string,
  ): Promise<{
    ok: boolean;
    logs: string[];
    output: string;
    blocked?: { blockId: string; instruction: string };
  }> {
    const row = await this.require(id, accountId);
    const content = parseSkill(row).content;
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
      const block: SkillContent['blocks'][number] = byId.get(current)!;
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
        case 'tool':
          logs.push(`调用 MCP 工具 ${block.tool ?? '（未指定）'}：测试环境跳过`);
          break;
      }
      const nexts: SkillContent['blocks'][number]['next'] = block.next ?? [];
      if (nexts.length === 0) break;
      const picked: NonNullable<SkillContent['blocks'][number]['next']>[number] = nexts[0]!;
      logs.push(`→ 分支「${picked.when}」`);
      current = byId.has(picked.to) ? picked.to : null;
      if (!current) logs.push(`分支目标 ${picked.to} 不存在，测试终止`);
    }

    const output = parts.join('\n\n');
    return blocked ? { ok: false, logs, output, blocked } : { ok: true, logs, output };
  }

  // ---------------------------------------------------------------- 导出/导入

  async export(id: string, accountId: string, res: Response): Promise<void> {
    const row = await this.require(id, accountId);
    const parsed = parseSkill(row);
    // 文件名只用 ASCII 安全字符，非 ASCII（中文技能名）回退到 skill id。
    const safeName = /^[\w.-]+$/.test(row.name) ? row.name : row.id;
    const payload = {
      name: row.name,
      type: row.type,
      content: parsed.content,
      version: row.currentVersion,
      mcp_dependencies: parsed.mcpDependencies,
      description: row.description,
      tags: parsed.tags,
      exported_at: new Date().toISOString(),
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.atskill"`);
    res.send(JSON.stringify(payload));
  }

  /** 导入 .atskill（multipart，字段 file）：解析后建新技能 v0.1.0 DRAFT，重名加后缀。 */
  async import(
    file: { buffer?: Buffer; originalname?: string } | undefined,
    accountId: string,
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
    const name = await this.availableName(payload.name.trim(), accountId);
    const deps = (payload.mcp_dependencies ?? payload.mcpDependencies ?? []) as SkillMcpDependency[];
    return this.create(
      {
        name,
        type: payload.type as SkillType,
        description: typeof payload.description === 'string' ? payload.description : '',
        tags: Array.isArray(payload.tags) ? (payload.tags as string[]).map(String) : [],
        content: (payload.content ?? EMPTY_CONTENT) as SkillContent,
        mcp_dependencies: deps,
      },
      accountId,
    );
  }

  // ---------------------------------------------------------------- 任务绑定（10.3）

  /**
   * PATCH /tasks/:id 的 skills 校验：归属当前账号、skill 存在、version 存在（缺省用 current）。
   * 返回补全 version 后的 JSON 串（存库口径：引用始终带显式版本，下发时不用再猜）。
   */
  async normalizeTaskBindings(accountId: string, refs: TaskSkillRef[]): Promise<string> {
    const resolved: TaskSkillRef[] = [];
    for (const ref of refs) {
      const skill = await this.prisma.skill.findFirst({
        where: { id: ref.skill_id, accountId },
        select: { id: true, currentVersion: true, versions: { select: { version: true } } },
      });
      if (!skill) {
        throw new ApiException('VALIDATION_FAILED', `技能 ${ref.skill_id} 不存在或不属于当前账号`, [
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
  async resolveForTask(accountId: string, skillsJson: string | null): Promise<TaskSkillPayload[]> {
    const refs = parseJson<TaskSkillRef[]>(skillsJson, []);
    if (refs.length === 0) return [];
    const payloads = await Promise.all(
      refs.map(async (ref): Promise<TaskSkillPayload | null> => {
        const skill = await this.prisma.skill.findFirst({
          where: { id: ref.skill_id, accountId },
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

  private async require(id: string, accountId: string): Promise<Skill> {
    const row = await this.prisma.skill.findFirst({ where: { id, accountId } });
    if (!row) throw new ApiException('NOT_FOUND', '技能不存在');
    return row;
  }

  private async boundTaskCount(id: string, accountId: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<{ count: number | bigint }[]>(
      `SELECT COUNT(*) AS count FROM tasks WHERE account_id = ? AND skills LIKE ?`,
      accountId,
      `%"${id}"%`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async availableName(name: string, accountId: string): Promise<string> {
    const existing = await this.prisma.skill.findMany({
      where: { accountId, name: { startsWith: name } },
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
