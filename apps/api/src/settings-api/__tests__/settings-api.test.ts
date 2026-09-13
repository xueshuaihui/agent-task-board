import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../../contract/settings';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import { PrismaService } from '../../infra/prisma.service';
import type { AppLogger } from '../../infra/logger';
import { SettingsService } from '../../infra/settings.service';
import { SettingsApiService } from '../settings-api.service';

/** 20.9 的键表校验在 `infra/settings.service.ts` 里，本测试验的是 controller 那层透传与审计。 */
let dir: string;
let prisma: PrismaService;
let settings: SettingsApiService;
let settingsService: SettingsService;
let logger: {
  setLevel: (level: Settings['log_level']) => void;
  applyRetentionDays: (days: number) => void;
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-settings-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  prisma = new PrismaService();
  logger = { setLevel: vi.fn(), applyRetentionDays: vi.fn() };
  settingsService = new SettingsService(prisma);
  settings = new SettingsApiService(
    settingsService,
    new AuditService(prisma),
    logger as unknown as AppLogger,
  );
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

describe('GET /settings', () => {
  it('迁移播种后的新库读回 20.9 全键默认值', async () => {
    const all = await settings.all();
    expect(all).toEqual(DEFAULT_SETTINGS);
    expect(Object.keys(all).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });

  it('库里被手改成非法值时回落默认值，读路径不崩（20.9 decodeSetting）', async () => {
    await prisma.setting.update({ where: { key: 'lease_ttl_minutes' }, data: { value: '9999' } });
    settingsService.invalidate();
    expect((await settings.all()).lease_ttl_minutes).toBe(
      DEFAULT_SETTINGS.lease_ttl_minutes,
    );
    await prisma.setting.update({
      where: { key: 'lease_ttl_minutes' },
      data: { value: String(DEFAULT_SETTINGS.lease_ttl_minutes) },
    });
    settingsService.invalidate();
  });
});

describe('PATCH /settings', () => {
  it('未知键 → 422 VALIDATION_FAILED，不新增键行、也不动已有值', async () => {
    const snapshotBefore = await prisma.setting.findMany({ orderBy: { key: 'asc' } });
    await expect(settings.patch({ no_such_key: 1 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
    expect(await prisma.setting.findUnique({ where: { key: 'no_such_key' } })).toBeNull();
    const snapshotAfter = await prisma.setting.findMany({ orderBy: { key: 'asc' } });
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it('越界值 → 422，details 里带是哪一项', async () => {
    const error = await settings
      .patch({ lease_ttl_minutes: 9999 })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(JSON.stringify((error as { details?: unknown }).details)).toContain(
      'lease_ttl_minutes',
    );
  });

  it('合法写入后返回全键当前值，并落一条 settings_change 审计（只含改动项）', async () => {
    const after = await settings.patch({ board_column_limit: 80, log_level: 'debug' });
    expect(after.board_column_limit).toBe(80);
    expect(after.log_level).toBe('debug');
    expect(after.auto_archive_days).toBe(DEFAULT_SETTINGS.auto_archive_days);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'settings_change' },
      orderBy: { id: 'desc' },
    });
    expect(audit?.targetType).toBe('settings');
    const before = JSON.parse(audit!.before as string) as Record<string, unknown>;
    const detail = JSON.parse(audit!.after as string) as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual(['board_column_limit', 'log_level']);
    expect(before.board_column_limit).toBe(DEFAULT_SETTINGS.board_column_limit);
    expect(detail.log_level).toBe('debug');
  });

  it('task_types 是数组键，写进去读得回来（20.9 唯一的 string[] 键）', async () => {
    const after = await settings.patch({ task_types: ['需求', '缺陷'] });
    expect(after.task_types).toEqual(['需求', '缺陷']);
  });

  it('重复写同一个值不再产生审计（不给日志 Tab 灌噪声）', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'settings_change' } });
    await settings.patch({ task_types: ['需求', '缺陷'] });
    expect(await prisma.auditLog.count({ where: { action: 'settings_change' } })).toBe(before);
  });

  it('log_level 改动同步给 AppLogger.setLevel（20.9 的热生效）', async () => {
    await settings.patch({ log_level: 'error' });
    expect(logger.setLevel).toHaveBeenCalledWith('error');
    const calls = (logger.setLevel as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await settings.patch({ log_level: 'error' });
    expect((logger.setLevel as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(calls);
  });

  it('log_retention_days 改动同步给 AppLogger.applyRetentionDays（验收 18 的热生效）', async () => {
    const apply = logger.applyRetentionDays as unknown as ReturnType<typeof vi.fn>;
    await settings.patch({ log_retention_days: 7 });
    expect(apply).toHaveBeenCalledWith(7);
    await settings.patch({ log_retention_days: 7 });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
