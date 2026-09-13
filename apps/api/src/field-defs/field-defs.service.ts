import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { FIELD_TYPES, type FieldType } from '../contract/enums';
import type { FieldOptions } from '../contract/custom-fields';
import { nowSql, toIso } from '../contract/time';
import { newId } from '../contract/ids';
import { parseJsonArray } from '../tasks/task.dto';
import type { FieldDefCreateInput, FieldDefPatchInput } from '../contract/schemas';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';

/** 卡片可见字段的可选项类型：6.9.1 末行——`textarea` 在 248px 卡片上必然截断成噪声。 */
const CARD_ELIGIBLE: FieldType[] = ['text', 'number', 'select', 'bool'];
const CARD_MAX = 2;

export interface FieldDefDto {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  default_value: string | null;
  options: FieldOptions;
  applies_to: string[];
  show_on_card: boolean;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * 6.9.1 的字段定义 CRUD。`key` 与 `type` 保存后不可改——改它们等于换一个字段，
 * 已落在任务上的旧值无处迁移，所以 PATCH 直接拒绝而不是静默忽略。
 */
@Injectable()
export class FieldDefsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async list(): Promise<{ items: FieldDefDto[] }> {
    const rows = await this.prisma.customFieldDef.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(toDto) };
  }

  async create(input: FieldDefCreateInput): Promise<FieldDefDto> {
    await this.assertTaskTypes(input.applies_to);
    this.assertOptions(input.type, input.options);
    if (input.default_value) this.assertDefault(input.type, input.default_value);
    const duplicate = await this.prisma.customFieldDef.findUnique({ where: { key: input.key } });
    if (duplicate) {
      throw new ApiException('VALIDATION_FAILED', `字段 key「${input.key}」已存在`, [
        { path: 'key', code: 'duplicate_key', message: '同一 key 不能建两份定义' },
      ]);
    }
    if (input.show_on_card) await this.assertCardSlots(input.type, true, null);

    const id = newId();
    const now = nowSql();
    await this.prisma.customFieldDef.create({
      data: {
        id,
        key: input.key,
        label: input.label,
        type: input.type,
        required: input.required ? 1 : 0,
        defaultValue: input.default_value ?? null,
        options: input.options === undefined ? null : JSON.stringify(input.options),
        appliesTo: JSON.stringify(input.applies_to),
        showOnCard: input.show_on_card ? 1 : 0,
        sortOrder: input.sort_order,
        enabled: input.enabled ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'field_def_change',
      targetType: 'field_def',
      targetId: input.key,
      after: { ...input },
    });
    return (await this.get(id)).dto;
  }

  async patch(id: string, input: FieldDefPatchInput): Promise<FieldDefDto> {
    const { dto: before } = await this.get(id);
    // PATCH 的 schema 已挡掉 key/type，走到这里只可能是别的属性；applies_to 仍需按词表校验。
    if (input.applies_to) await this.assertTaskTypes(input.applies_to);
    const type = before.type;
    if (input.options !== undefined) this.assertOptions(type, input.options);
    if (input.default_value) this.assertDefault(type, input.default_value);
    await this.assertCardSlots(
      type,
      input.show_on_card ?? before.show_on_card,
      before.show_on_card ? id : null,
    );

    await this.prisma.customFieldDef.update({
      where: { id },
      data: {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.required === undefined ? {} : { required: input.required ? 1 : 0 }),
        ...(input.default_value === undefined
          ? {}
          : { defaultValue: input.default_value ?? null }),
        ...(input.options === undefined ? {} : { options: JSON.stringify(input.options) }),
        ...(input.applies_to === undefined ? {} : { appliesTo: JSON.stringify(input.applies_to) }),
        ...(input.show_on_card === undefined
          ? {}
          : { showOnCard: input.show_on_card ? 1 : 0 }),
        ...(input.sort_order === undefined ? {} : { sortOrder: input.sort_order }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled ? 1 : 0 }),
        updatedAt: nowSql(),
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'field_def_change',
      targetType: 'field_def',
      targetId: before.key,
      before: { ...before },
      after: { ...input },
    });
    return (await this.get(id)).dto;
  }

  /** 13 章：删除只对未被任何任务引用的字段开放，被引用时提示「改用停用」。 */
  async remove(id: string): Promise<{ id: string; deleted: boolean }> {
    const { dto } = await this.get(id);
    const rows = await this.prisma.$queryRaw<{ count: number | bigint }[]>`
      SELECT COUNT(*) AS count FROM tasks
      WHERE custom_fields IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM json_each(custom_fields) e WHERE e.key = ${dto.key})`;
    const used = Number(rows[0]?.count ?? 0);
    if (used > 0) {
      throw new ApiException('FIELD_IN_USE', `该字段已被 ${used} 个任务使用，改为停用？`, {
        task_count: used,
      });
    }
    await this.prisma.customFieldDef.delete({ where: { id } });
    await this.audit.record({
      actorType: 'user',
      action: 'field_def_change',
      targetType: 'field_def',
      targetId: dto.key,
      before: { ...dto },
      after: { deleted: true },
    });
    return { id, deleted: true };
  }

  private async get(id: string): Promise<{ dto: FieldDefDto }> {
    const row = await this.prisma.customFieldDef.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', `字段定义 ${id} 不存在`);
    return { dto: toDto(row) };
  }

  /** 6.9.1：全表最多 2 个字段可上卡片，且仅限文本/数字/单选/布尔。`excludeId` 用于 PATCH 时不算自己。 */
  private async assertCardSlots(
    type: FieldType,
    wantCard: boolean,
    excludeId: string | null,
  ): Promise<void> {
    if (!wantCard) return;
    if (!CARD_ELIGIBLE.includes(type)) {
      throw new ApiException('VALIDATION_FAILED', `「${type}」类型不能上卡片`, [
        {
          path: 'show_on_card',
          code: 'card_type',
          message: `卡片字段仅限 ${CARD_ELIGIBLE.join(' / ')}`,
        },
      ]);
    }
    const rows = await this.prisma.customFieldDef.findMany({ where: { showOnCard: 1 } });
    const current = rows.filter((row) => row.id !== excludeId).length;
    if (current + 1 > CARD_MAX) {
      throw new ApiException(
        'VALIDATION_FAILED',
        `卡片最多显示 ${CARD_MAX} 个自定义字段，请先取消另一个字段的「卡片显示」`,
        [{ path: 'show_on_card', code: 'card_limit', message: `当前已占用 ${current} 个槽位` }],
      );
    }
  }

  /** `options` 的形态必须与类型匹配，否则任务侧的校验会拿到一份永远不匹配的候选表。 */
  private assertOptions(type: FieldType, options: unknown): void {
    const bad = (message: string): never => {
      throw new ApiException('VALIDATION_FAILED', `类型「${type}」的选项不合法`, [
        { path: 'options', code: 'options_shape', message },
      ]);
    };
    if (options === undefined || options === null) {
      if (type === 'select' || type === 'multiselect') bad('单选/多选必须给候选值数组');
      return;
    }
    const isNumberish = (v: unknown): boolean =>
      v === null || typeof v === 'number' || typeof v === 'string';
    if (type === 'number') {
      if (Array.isArray(options) || typeof options !== 'object') bad('数字类型应为 {min,max} 或留空');
      const record = options as Record<string, unknown>;
      if (!isNumberish(record.min) || !isNumberish(record.max)) bad('min/max 只能是数字或 null');
      const { min, max } = record as { min?: number; max?: number };
      if (typeof min === 'number' && typeof max === 'number' && min > max) bad('min 不能大于 max');
      return;
    }
    if (!Array.isArray(options)) bad('该类型的选项应为候选值数组');
    if (type !== 'select' && type !== 'multiselect') {
      bad(`只有单选/多选使用候选值数组，「${type}」不应带 options`);
    }
  }

  /** `default_value` 存文本（20.10），按类型试解析一次，别让默认值本身违反契约。 */
  private assertDefault(type: FieldType, raw: string): void {
    const issue = (message: string): never => {
      throw new ApiException('VALIDATION_FAILED', `默认值不合法：${message}`, [
        { path: 'default_value', code: 'default_value', message },
      ]);
    };
    if (type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) issue('需为数字');
      return;
    }
    if (type === 'bool') {
      if (!['true', 'false', '1', '0'].includes(raw)) issue('需为 true/false');
      return;
    }
    if (type === 'select') {
      const parsed = this.parseSelectDefaults(raw);
      if (parsed.length === 0) issue('单选默认值需在候选值内');
    }
  }

  private parseSelectDefaults(raw: string): string[] {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.map(String) : [String(value)];
    } catch {
      return [raw];
    }
  }

  /** `applies_to` 里的类型名要在 `task_types` 词表内（20.9），否则该字段永远不渲染。 */
  private async assertTaskTypes(appliesTo: string[]): Promise<void> {
    if (appliesTo.length === 0) return;
    const types = await this.settings.get('task_types');
    const unknown = appliesTo.filter((item) => !types.includes(item));
    if (unknown.length > 0) {
      throw new ApiException('VALIDATION_FAILED', '适用类型不在任务类型词表内', [
        {
          path: 'applies_to',
          code: 'unknown_type',
          message: `未知：${unknown.join(' / ')}；可选：${types.join(' / ')}`,
        },
      ]);
    }
  }
}

function toDto(row: {
  id: string;
  key: string;
  label: string;
  type: string;
  required: number;
  defaultValue: string | null;
  options: string | null;
  appliesTo: string | null;
  showOnCard: number;
  sortOrder: number | null;
  enabled: number;
  createdAt: string;
  updatedAt: string;
}): FieldDefDto {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: (FIELD_TYPES as readonly string[]).includes(row.type)
      ? (row.type as FieldType)
      : 'text',
    required: row.required === 1,
    default_value: row.defaultValue,
    options: parseOptions(row.options),
    applies_to: parseJsonArray(row.appliesTo),
    show_on_card: row.showOnCard === 1,
    sort_order: row.sortOrder ?? 0,
    enabled: row.enabled === 1,
    created_at: toIso(row.createdAt) ?? row.createdAt,
    updated_at: toIso(row.updatedAt) ?? row.updatedAt,
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
