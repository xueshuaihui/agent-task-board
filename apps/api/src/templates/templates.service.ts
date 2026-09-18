import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import type { FieldType } from '../contract/enums';
import {
  validateFieldValue,
  type FieldDefLike,
  type FieldOptions,
} from '../contract/custom-fields';
import { newId } from '../contract/ids';
import { nowSql } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { parseJsonArray } from '../tasks/task.dto';
import {
  encodePreset,
  toTemplateDto,
  type TemplateCreateBody,
  type TemplateDto,
  type TemplatePatchBody,
  type TemplatePresetInput,
} from './template.dto';

/** 7.5：模板只影响创建瞬间，任务上不存模板外键——所以删除模板永远不回头动任务。 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async list(accountId: string): Promise<{ items: TemplateDto[] }> {
    const rows = await this.prisma.taskTemplate.findMany({
      where: { accountId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(toTemplateDto) };
  }

  async create(accountId: string, input: TemplateCreateBody): Promise<TemplateDto> {
    await this.assertPreset(input.preset);
    const id = newId();
    const now = nowSql();
    await this.prisma.taskTemplate.create({
      data: {
        id,
        accountId,
        name: input.name,
        description: input.description ?? null,
        preset: encodePreset(input.preset),
        sortOrder: input.sort_order,
        createdAt: now,
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'template_change',
      targetType: 'template',
      targetId: id,
      after: { name: input.name, preset: input.preset },
    });
    return toTemplateDto(await this.getRow(accountId, id));
  }

  /**
   * `preset` 传了就是整份替换（7.5 的编辑弹窗本来就提交全量表单），
   * 其余顶层键按提供的改；没带的键保持原值，避免「改个名字顺手清了标签」。
   */
  async patch(accountId: string, id: string, input: TemplatePatchBody): Promise<TemplateDto> {
    const before = await this.getRow(accountId, id);
    if (input.preset) await this.assertPreset(input.preset);
    await this.prisma.taskTemplate.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.preset === undefined ? {} : { preset: encodePreset(input.preset) }),
        ...(input.sort_order === undefined ? {} : { sortOrder: input.sort_order }),
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'template_change',
      targetType: 'template',
      targetId: id,
      before: { name: before.name, sort_order: before.sortOrder },
      after: { ...input },
    });
    return toTemplateDto(await this.getRow(accountId, id));
  }

  async remove(accountId: string, id: string): Promise<{ id: string; deleted: boolean }> {
    const row = await this.getRow(accountId, id);
    await this.prisma.taskTemplate.delete({ where: { id } });
    await this.audit.record({
      actorType: 'user',
      action: 'template_change',
      targetType: 'template',
      targetId: id,
      before: { name: row.name },
      after: { deleted: true },
    });
    return { id, deleted: true };
  }

  private async getRow(accountId: string, id: string) {
    const row = await this.prisma.taskTemplate.findFirst({ where: { id, accountId } });
    if (!row) throw new ApiException('NOT_FOUND', `模板 ${id} 不存在`);
    return row;
  }

  /**
   * 只校验**本次提交里出现**的预填键：模板可能建在某个任务类型被删掉之前，
   * 7.5 对这种失效预填的口径是「静默跳过 + 标警告」，不是让模板编辑界面存不下东西。
   */
  private async assertPreset(preset: TemplatePresetInput): Promise<void> {
    if (preset.type !== undefined) await this.assertTaskType(preset.type);
    if (preset.custom_fields !== undefined) await this.assertCustomFields(preset.custom_fields);
  }

  private async assertTaskType(type: string): Promise<void> {
    const types = await this.settings.get('task_types');
    if (types.includes(type)) return;
    throw new ApiException('VALIDATION_FAILED', `预填类型「${type}」不在任务类型词表内`, [
      { path: 'preset.type', code: 'unknown_type', message: `可选：${types.join(' / ')}` },
    ]);
  }

  /** 验收 25：选模板要能直接建出合法任务，所以自定义字段默认值按 20.10 就地校验。 */
  private async assertCustomFields(fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const rows = await this.prisma.customFieldDef.findMany({
      where: { key: { in: entries.map(([key]) => key) } },
    });
    const defs = new Map(rows.map((row) => [row.key, toFieldDefLike(row)]));
    for (const [key, value] of entries) {
      const def = defs.get(key);
      if (!def) {
        throw new ApiException('VALIDATION_FAILED', `预填字段「${key}」没有对应的字段定义`, [
          { path: `preset.custom_fields.${key}`, code: 'unknown_field', message: '先在字段定义 Tab 建好' },
        ]);
      }
      if (!def.enabled) {
        throw new ApiException('VALIDATION_FAILED', `字段「${key}」已停用，不能作为模板预填`, [
          { path: `preset.custom_fields.${key}`, code: 'disabled_field', message: '7.5：下拉只列启用字段' },
        ]);
      }
      const issue = validateFieldValue(def, value, { present: true });
      if (issue) {
        throw new ApiException('VALIDATION_FAILED', `预填字段「${key}」不合法：${issue.message}`, [
          { path: `preset.custom_fields.${key}`, code: issue.key, message: issue.message },
        ]);
      }
    }
  }
}

/** 把库行整形成 20.10 校验器要的 `FieldDefLike`；`enabled` 多带一位，供上面的停用判定用。 */
function toFieldDefLike(row: {
  key: string;
  label: string;
  type: string;
  required: number;
  options: string | null;
  appliesTo: string | null;
  enabled: number;
}): FieldDefLike & { enabled: boolean } {
  return {
    key: row.key,
    label: row.label,
    type: row.type as FieldType,
    required: row.required === 1,
    options: parseOptions(row.options),
    appliesTo: parseJsonArray(row.appliesTo),
    enabled: row.enabled === 1,
  };
}

function parseOptions(raw: string | null): FieldOptions {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return {
        min: typeof record.min === 'number' ? record.min : undefined,
        max: typeof record.max === 'number' ? record.max : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}
