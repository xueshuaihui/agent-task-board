import type { ArgumentMetadata } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitySchema } from '../../contract/schemas';
import { newId } from '../../contract/ids';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { ZodPipe } from '../../infra/zod.pipe';
import { templatePatchBodySchema } from '../template.dto';
import { TemplatesService } from '../templates.service';

/**
 * 6.11 / 13 章模板接口。临时库独立，不连 apps/api/prisma/dev.db。
 * 重点验两件事：验收 25 的「preset 能直接喂给建任务表单」，以及 7.5 的「删除不回溯任务」。
 */
let dir: string;
let prisma: PrismaService;
let templates: TemplatesService;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-templates-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  prisma = new PrismaService();
  const settings = new SettingsService(prisma);
  templates = new TemplatesService(prisma, new AuditService(prisma), settings);
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

/** 建一个 select 字段定义，供 preset 的自定义字段默认值用（20.10 要按候选值校验）。 */
async function seedFieldDef(key: string, options: string[], enabled = 1): Promise<void> {
  await prisma.customFieldDef.create({
    data: {
      id: newId(),
      key,
      label: key,
      type: 'select',
      options: JSON.stringify(options),
      appliesTo: '[]',
      enabled,
    },
  });
}

const fullPreset = {
  title_prefix: '【缺陷】',
  description: '复现步骤：',
  type: '缺陷',
  priority: 1,
  tags: ['后端'],
  required_capabilities: ['language:java'],
  custom_fields: { impact_scope: '订单模块' },
};

describe('POST + GET /templates', () => {
  it('preset 原样读回，键名与 taskCreateSchema 对齐（验收 25）', async () => {
    await seedFieldDef('impact_scope', ['订单模块', '支付']);
    const created = await templates.create({
      name: '缺陷修复',
      description: '线上缺陷用',
      preset: fullPreset,
      sort_order: 1,
    });
    expect(created.preset).toEqual(fullPreset);
    expect(created.name).toBe('缺陷修复');
    expect(created.description).toBe('线上缺陷用');
    expect(created.sort_order).toBe(1);
    expect(created.created_at).toMatch(/Z$/);

    const { items } = await templates.list();
    expect(items.map((item) => item.name)).toEqual(['缺陷修复']);
    // 建任务表单可以 `{...preset, title: preset.title_prefix + 输入}` 直接摊开
    const formKeys = Object.keys(created.preset).sort();
    expect(formKeys).toContain('title_prefix');
    expect(formKeys).toEqual([
      'custom_fields',
      'description',
      'priority',
      'required_capabilities',
      'tags',
      'title_prefix',
      'type',
    ]);
  });

  it('落库的 preset 是 JSON 文本（DDL 的 preset NOT NULL）', async () => {
    const { items } = await templates.list();
    const row = await prisma.taskTemplate.findUnique({ where: { id: items[0].id } });
    expect(typeof row!.preset).toBe('string');
    expect(JSON.parse(row!.preset)).toMatchObject({ title_prefix: '【缺陷】' });
  });

  it('写一条 template_change 审计', async () => {
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'template_change' },
      orderBy: { id: 'desc' },
    });
    expect(audit?.targetType).toBe('template');
    expect(JSON.parse(audit!.after as string)).toMatchObject({ name: '缺陷修复' });
  });

  it('预填类型不在 20.9 词表内 → 422', async () => {
    await expect(
      templates.create({ name: '坏模板', preset: { type: '不存在的类型' }, sort_order: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('预填字段没有对应定义 / 已停用 / 值违反 20.10 → 一律 422', async () => {
    const bad = (custom_fields: Record<string, unknown>) =>
      templates.create({ name: '字段坏', preset: { custom_fields }, sort_order: 0 });
    await expect(bad({ ghost: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(bad({ impact_scope: '不在候选值里' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await seedFieldDef('legacy_flag', ['a'], 0);
    await expect(bad({ legacy_flag: 'a' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('能力预填按 20.5 的 namespace:value 形状收（非法形状由 zod 挡）', async () => {
    expect(capabilitySchema.safeParse('language:java').success).toBe(true);
    expect(capabilitySchema.safeParse('java').success).toBe(false);
  });
});

describe('PATCH /templates/:id', () => {
  const bodyMeta: ArgumentMetadata = { type: 'body', metatype: Object, data: 'id' };
  /** 走真实入参管线：`.partial()` 的 default 回填这类问题只有在 pipe 后才看得到。 */
  const patchThrough = (id: string, body: unknown) =>
    templates.patch(id, new ZodPipe(templatePatchBodySchema).transform(body, bodyMeta));

  it('只改 name 时 preset 与 sort_order 都不动', async () => {
    const created = await templates.create({
      name: '接口开发',
      preset: { type: '需求', priority: 2, tags: ['api'] },
      sort_order: 7,
    });
    const patched = await patchThrough(created.id, { name: '接口开发 v2' });
    expect(patched.name).toBe('接口开发 v2');
    expect(patched.sort_order).toBe(7);
    expect(patched.preset).toEqual({ type: '需求', priority: 2, tags: ['api'] });
  });

  it('传了 preset 即整份替换（编辑弹窗提交全量表单）', async () => {
    const created = await templates.create({
      name: '代码巡检',
      preset: { type: '巡检', priority: 3, tags: ['scan'] },
      sort_order: 0,
    });
    const patched = await templates.patch(created.id, { preset: { type: '重构' } });
    expect(patched.preset).toEqual({ type: '重构' });
  });

  it('空 PATCH 在入参层就拒（不给审计灌模板噪声）', async () => {
    const pipe = new ZodPipe(templatePatchBodySchema);
    const meta: ArgumentMetadata = { type: 'body', metatype: Object, data: undefined };
    expect(() => pipe.transform({}, meta)).toThrowError();
    expect(() => pipe.transform({ name: 'x' }, meta)).not.toThrow();
  });

  it('不存在的 id → 404', async () => {
    await expect(templates.patch('00000000-0000-4000-8000-000000000000', { name: 'x' })).rejects.toMatchObject(
      { code: 'NOT_FOUND', status: 404 },
    );
  });
});

describe('DELETE /templates/:id', () => {
  it('删除不回溯任务：模板行没了，任务字段一字不改（7.5）', async () => {
    const template = await templates.create({
      name: '待删模板',
      preset: fullPreset,
      sort_order: 0,
    });
    const created = await prisma.task.create({
      data: {
        id: 'T-9100',
        type: '缺陷',
        title: '【缺陷】支付回调失败',
        priority: 1,
        tags: JSON.stringify(['后端']),
        requiredCapabilities: JSON.stringify(['language:java']),
        customFields: JSON.stringify(template.preset.custom_fields),
      },
    });

    await templates.remove(template.id);

    expect(await prisma.taskTemplate.findUnique({ where: { id: template.id } })).toBeNull();
    const task = await prisma.task.findUnique({ where: { id: 'T-9100' } });
    expect(task!.customFields).toBe(JSON.stringify({ impact_scope: '订单模块' }));
    expect(task!.requiredCapabilities).toContain('language:java');
    expect(created.id).toBe('T-9100');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'template_change', targetId: template.id },
      orderBy: { id: 'desc' },
    });
    expect(JSON.parse(audit!.after as string)).toEqual({ deleted: true });
  });

  it('再删一次 404，列表里没有幽灵行', async () => {
    const template = await templates.create({ name: '只删一次', preset: {}, sort_order: 0 });
    await templates.remove(template.id);
    await expect(templates.remove(template.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
    const { items } = await templates.list();
    expect(items.map((item) => item.id)).not.toContain(template.id);
  });
});
