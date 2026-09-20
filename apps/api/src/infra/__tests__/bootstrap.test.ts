import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyMigrations, migrationsDir } from '../bootstrap';

/** 迁移水位对齐（2026-09-15 真机缺陷 #2）：既有库（prisma migrate 建，无 user_version）不重放 0001。 */
describe('applyMigrations 水位对齐', () => {
  const dirs: string[] = [];

  function makeDataDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'atb-mig-'));
    dirs.push(dir);
    process.env.ATB_DATA_DIR = dir;
    process.env.ATB_LOGS_DIR = path.join(dir, 'logs');
    return dir;
  }

  beforeEach(() => {
    delete process.env.ATB_DATA_DIR;
    delete process.env.ATB_LOGS_DIR;
  });

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('空库：正常应用全部迁移', () => {
    const dir = makeDataDir();
    const applied = applyMigrations();
    expect(applied.length).toBeGreaterThan(0);
    const db = new DatabaseSync(path.join(dir, 'jarvis.db'), { readOnly: true });
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(applied[applied.length - 1]);
    db.close();
  });

  it('既有库（_prisma_migrations 账本 + 全部表、水位 0）：对齐水位、不重放', () => {
    const dir = makeDataDir();
    // 先用官方迁移建一个「开发期库」，再抹掉水位，模拟 db.mjs（prisma migrate deploy）的产物。
    applyMigrations();
    const db = new DatabaseSync(path.join(dir, 'jarvis.db'));
    db.exec('PRAGMA user_version = 0');
    db.close();

    const applied = applyMigrations();
    expect(applied).toEqual([]); // 不应重放任何迁移

    const check = new DatabaseSync(path.join(dir, 'jarvis.db'), { readOnly: true });
    const row = check.prepare('PRAGMA user_version').get() as { user_version: number };
    const maxOrder = Math.max(
      ...applyMigrationsBundleNames().map((name) => Number(name.split('_')[0])),
    );
    expect(row.user_version).toBe(maxOrder);
    check.close();
  });

  it('既有库（有表、无账本）：对齐到全量水位、不重放', () => {
    const dir = makeDataDir();
    const db = new DatabaseSync(path.join(dir, 'jarvis.db'));
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
    db.close();

    const applied = applyMigrations();
    expect(applied).toEqual([]);
  });

  it('migrationsDir 候选链能找到仓库迁移目录', () => {
    expect(migrationsDir()).toContain(path.join('prisma', 'migrations'));
  });
});

/** 读打包迁移目录里的编号（避免与 collectMigrations 重复实现细节耦合，仅取名字排序）。 */
function applyMigrationsBundleNames(): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(migrationsDir())
    .filter((name) => /^\d+_/.test(name))
    .sort();
}
