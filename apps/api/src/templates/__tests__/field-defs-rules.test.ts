import type { ArgumentMetadata } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fieldDefCreateSchema, fieldDefPatchSchema } from '../../contract/schemas';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { ZodPipe } from '../../infra/zod.pipe';
import { BUILTIN_ACCOUNT_ID as BUILTIN } from '../../auth/accounts.service';
import { FieldDefsService } from '../../field-defs/field-defs.service';

/**
 * 13 章字段接口两条硬规则的回归（`field-defs/` 目录由主线维护，这里**只读**核验，
 * 不改它的实现）：
 * 1. PATCH 改 `key`/`type` → 422 VALIDATION_FAILED；
 * 2. DELETE 被任务引用的字段 → 409 FIELD_IN_USE，且 `details.task_count` 给出引用数。
 * 放在 templates 旁边，是因为模板的 `preset.custom_fields` 与任务共用同一套 20.10 契约，
 * 这两条规则一旦漂移，模板预填会跟着错。
 */
let dir: string;
let prisma: PrismaService;
let defs: FieldDefsService;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-fielddefs-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  prisma = new PrismaService();
  const settings = new SettingsService(prisma);
  defs = new FieldDefsService(prisma, new AuditService(prisma), settings);
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

async function createDef(key = 'impact_scope'): Promise<string> {
  return (await defs.create(BUILTIN,{
    key,
    label: '影响范围',
    type: 'select',
    required: false,
    options: ['订单模块', '支付'],
    applies_to: [],
    show_on_card: false,
    sort_order: 0,
    enabled: true,
  })).id;
}

let taskSeq = 9100;

async function taskUsing(key: string, value: unknown): Promise<void> {
  taskSeq += 1;
  await prisma.task.create({
    data: {
      id: `T-${taskSeq}`,
      title: key,
      customFields: JSON.stringify({ [key]: value }),
    },
  });
}

describe('规则 1：PATCH 改 key / type 一律 422', () => {
  const meta: ArgumentMetadata = { type: 'body', metatype: Object, data: 'id' };
  const pipe = new ZodPipe(fieldDefPatchSchema);

  const caught = (body: unknown): { code?: string; status?: number } | null => {
    try {
      pipe.transform(body, meta);
      return null;
    } catch (error) {
      return error as { code?: string; status?: number };
    }
  };

  it('带 key 的 PATCH 被入参层挡掉，错误码 VALIDATION_FAILED / 422', () => {
    expect(caught({ key: 'other_name' })).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
  });

  it('带 type 的 PATCH 同样 422', () => {
    expect(caught({ type: 'text' })).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  /**
   * PATCH 的两处历史缺陷（现已在 contract 修好，这里钉住防漂移）：
   * 1. 守卫写成 `z.any().refine(v => v === undefined)` 时 zod 4 下 `z.any()` 不带 optional，
   *    于是**任何** PATCH（连只改 label 的合法请求）都被 key/type 两条缺省判定挡掉 → 设置页存不了。
   * 2. `.partial()` 不剥 default，放行后又会把 required/show_on_card/sort_order/enabled
   *    回填进解析输出，service 当成用户本次改动写库 → 每次编辑都静默重置这四个配置。
   */
  it('只改 label 能放行，且解析输出不含任何未提交的键', () => {
    const allowed = fieldDefPatchSchema.safeParse({ label: '新名字' });
    expect(allowed.success).toBe(true);
    expect(allowed.data).toEqual({ label: '新名字' });
  });

  it('不可变键仍然一律 422，空 PATCH 也拒', () => {
    expect(fieldDefPatchSchema.safeParse({ label: 'x', key: 'y' }).success).toBe(false);
    expect(fieldDefPatchSchema.safeParse({ type: 'text' }).success).toBe(false);
    expect(fieldDefPatchSchema.safeParse({}).success).toBe(false);
  });

  it('服务端二次兜底：绕过入参层直接调 service 也不会改库行的 key/type', async () => {
    const id = await createDef();
    await defs.patch(BUILTIN,id, { label: '影响范围 v2' });
    const row = await prisma.customFieldDef.findUnique({ where: { id } });
    expect(row!.key).toBe('impact_scope');
    expect(row!.type).toBe('select');
    expect(row!.label).toBe('影响范围 v2');
  });
});

describe('规则 2：DELETE 被引用 → 409 FIELD_IN_USE + details.task_count', () => {
  it('无引用的字段可直接删', async () => {
    const id = await createDef('unused_scope');
    expect(await defs.remove(BUILTIN,id)).toMatchObject({ id, deleted: true });
    expect(await prisma.customFieldDef.findUnique({ where: { id } })).toBeNull();
  });

  it('被 N 个任务引用时 409，details.task_count = N，定义仍在', async () => {
    const id = await createDef('used_scope');
    await taskUsing('used_scope', '订单模块');
    await taskUsing('used_scope', '支付');

    const error = await defs.remove(BUILTIN,id).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'FIELD_IN_USE', status: 409 });
    expect((error as { details?: unknown }).details).toMatchObject({ task_count: 2 });
    expect(await prisma.customFieldDef.findUnique({ where: { id } })).not.toBeNull();
  });

  it('值为 null 的引用也算引用（键在，定义就不能删）', async () => {
    const id = await createDef('null_scope');
    await taskUsing('null_scope', null);
    await expect(defs.remove(BUILTIN,id)).rejects.toMatchObject({ code: 'FIELD_IN_USE' });
  });

  it('任务删除后引用消失，字段可删（号位不复用，用新 T- 号）', async () => {
    const id = await createDef('later_free');
    await taskUsing('later_free', '订单模块');
    await expect(defs.remove(BUILTIN,id)).rejects.toMatchObject({ code: 'FIELD_IN_USE' });
    await prisma.task.deleteMany({ where: { customFields: { contains: 'later_free' } } });
    expect(await defs.remove(BUILTIN,id)).toMatchObject({ deleted: true });
  });
});

describe('两条规则之外的既有约束（顺带钉住，防止漂移）', () => {
  it('同一 key 不能建两份定义', async () => {
    await createDef('dup_key');
    await expect(
      defs.create(BUILTIN,{
        key: 'dup_key',
        label: '重复',
        type: 'text',
        required: false,
        applies_to: [],
        show_on_card: false,
        sort_order: 0,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('卡片字段全表最多 2 个、且仅限 text/number/select/bool（6.9.1）', async () => {
    const card = (key: string, type: 'text' | 'textarea') =>
      defs.create(BUILTIN,{
        key,
        label: key,
        type,
        required: false,
        applies_to: [],
        show_on_card: true,
        sort_order: 0,
        enabled: true,
      });
    await card('card_a', 'text');
    await card('card_b', 'text');
    await expect(card('card_c', 'text')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(card('card_d', 'textarea')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
