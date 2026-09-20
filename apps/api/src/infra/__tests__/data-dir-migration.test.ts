import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { defaultDataDir, legacyDataDir } from '../../common/paths';
import { applyMigrations, collectMigrations, migrationsDir } from '../bootstrap';
import {
  GUIDANCE_FILE_NAME,
  MIGRATED_FROM_KEY,
  MIGRATED_FROM_VALUE,
  MIGRATION_AUDIT_ACTION,
  migrateLegacyDataDir,
} from '../data-dir-migration';

/**
 * v0.0.4 W1b（需求.md §21.1/§21.2）：数据目录 `~/.agent-board` → `~/.jarvis-workbench`
 * 首启一次性搬迁。全部用例跑在假 HOME（mkdtemp）里，绝不触达真机数据目录。
 */
describe('migrateLegacyDataDir 首启一次性搬迁', () => {
  const cleanups: Array<() => void> = [];
  const envKeys = ['HOME', 'USERPROFILE', 'APPDATA', 'ATB_DATA_DIR', 'ATB_LOGS_DIR', 'ATB_MIGRATIONS_DIR'];
  let savedEnv: Record<string, string | undefined>;

  /** 搭一个假 HOME，返回 { home, legacy, target }；target 按桌面端注入 ATB_DATA_DIR 的口径设好。 */
  function makeFakeHome(): { home: string; legacy: string; target: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'atb-fakehome-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
    const target = defaultDataDir();
    process.env.ATB_DATA_DIR = target;
    process.env.ATB_LOGS_DIR = path.join(home, 'logs');
    return { home, legacy: legacyDataDir(), target };
  }

  /** 在旧目录造一个停在 0006 水位的库（等价于 v0.0.3 真库的 schema 状态）。 */
  function writeLegacyDbAt0006(legacyDir: string): string {
    mkdirSync(legacyDir, { recursive: true });
    const file = path.join(legacyDir, 'atb.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const migration of collectMigrations(migrationsDir()).filter((m) => m.order <= 6)) {
      db.exec('BEGIN');
      db.exec(migration.sql);
      db.exec('COMMIT');
    }
    db.exec('PRAGMA user_version = 6');
    // 塞一条自定义存量数据，验证搬迁把用户数据原样带走（0001 自带 settings 默认行）。
    db.prepare("INSERT INTO settings (key, value) VALUES ('drill_marker', '\"kept\"')").run();
    db.close();
    return file;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function openReadOnly(file: string): DatabaseSync {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }

  it('Happy path：备份→复制→补 0007/0008→审计→指引文件→旧库封存', () => {
    const { legacy, target } = makeFakeHome();
    const legacyDb = writeLegacyDbAt0006(legacy);
    writeFileSync(path.join(legacy, 'config.json'), '{"port":7790}\n');
    writeFileSync(path.join(legacy, 'window-state.json'), '{"width":1200}');
    mkdirSync(path.join(legacy, 'artifacts'), { recursive: true });
    writeFileSync(path.join(legacy, 'artifacts', 'a.txt'), 'artifact');

    const result = migrateLegacyDataDir();
    expect(result.migrated).toBe(true);
    expect(result.backupFile).toBeDefined();

    // 新库存在且 schema 到 0008：groups 已改名（0008）、accounts 已删（0007）。
    const newDb = openReadOnly(path.join(target, 'jarvis.db'));
    expect(
      (newDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(8);
    const tables = new Set(
      (newDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    );
    expect(tables.has('groups')).toBe(true);
    expect(tables.has('accounts')).toBe(false);
    // §21.2-3：settings.migrated_from + migration.completed 审计。
    expect(
      (newDb.prepare('SELECT value FROM settings WHERE key = ?').get(MIGRATED_FROM_KEY) as {
        value: string;
      }).value,
    ).toBe(MIGRATED_FROM_VALUE);
    const audit = newDb
      .prepare('SELECT actor_type, target_type FROM audit_logs WHERE action = ?')
      .get(MIGRATION_AUDIT_ACTION) as { actor_type: string; target_type: string };
    expect(audit.actor_type).toBe('system');
    expect(audit.target_type).toBe('data');
    // 存量数据随行迁移带过来。
    expect(
      (newDb.prepare("SELECT value FROM settings WHERE key = 'drill_marker'").get() as { value: string })
        .value,
    ).toBe('"kept"');
    newDb.close();

    // §21.2-1：先整库备份到 backups/（备份停在 0006 水位，是搬迁前的原始快照）。
    expect(existsSync(result.backupFile as string)).toBe(true);
    const backup = openReadOnly(result.backupFile as string);
    expect((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6);
    backup.close();

    // 运行期文件随迁：config/window-state/artifacts。
    expect(JSON.parse(readFileSync(path.join(target, 'config.json'), 'utf8')).port).toBe(7790);
    expect(existsSync(path.join(target, 'artifacts', 'a.txt'))).toBe(true);

    // §21.1：旧位置留只读指引文件；旧库封存改名，旧目录不再有可读写活的库。
    const guidance = path.join(legacy, GUIDANCE_FILE_NAME);
    expect(existsSync(guidance)).toBe(true);
    expect(readFileSync(guidance, 'utf8')).toContain(defaultDataDir());
    if (process.platform !== 'win32') {
      expect(readStatMode(guidance) & 0o222).toBe(0);
    }
    expect(existsSync(legacyDb)).toBe(false);
    expect(existsSync(`${legacyDb}.migrated`)).toBe(true);

    // main.ts 首启在搬迁后还会再跑一遍 applyMigrations：必须幂等空转。
    expect(applyMigrations()).toEqual([]);
  });

  it('幂等：重复执行第二次不搬、不报错、不追加审计', () => {
    const { legacy, target } = makeFakeHome();
    const legacyDb = writeLegacyDbAt0006(legacy);
    expect(migrateLegacyDataDir().migrated).toBe(true);

    const again = migrateLegacyDataDir();
    expect(again.migrated).toBe(false);
    expect(again.reason).toContain('视为已搬迁');
    expect(existsSync(path.join(target, 'jarvis.db'))).toBe(true);
    expect(existsSync(`${legacyDb}.migrated`)).toBe(true);
    const db = openReadOnly(path.join(target, 'jarvis.db'));
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?').get(MIGRATION_AUDIT_ACTION) as {
        n: number;
      }).n,
    ).toBe(1);
    db.close();
    // 再来一次也稳定（幂等第三次）。
    expect(migrateLegacyDataDir().migrated).toBe(false);
  });

  it('新目录已有 jarvis.db：不覆盖现场，只补指引', () => {
    const { legacy, target } = makeFakeHome();
    const legacyDb = writeLegacyDbAt0006(legacy);
    mkdirSync(target, { recursive: true });
    const db = new DatabaseSync(path.join(target, 'jarvis.db'));
    db.exec('PRAGMA user_version = 8');
    db.close();

    const result = migrateLegacyDataDir();
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('不覆盖');
    // 现场未动：新库还是那张空库，旧库也还在（没人替用户决断两库合并）。
    expect((readUserVersion(path.join(target, 'jarvis.db')))).toBe(8);
    const check = new DatabaseSync(path.join(target, 'jarvis.db'), { readOnly: true });
    expect(
      (check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='groups'").get() as { n: number }).n,
    ).toBe(0);
    check.close();
    expect(existsSync(legacyDb)).toBe(true);
    expect(existsSync(path.join(legacy, GUIDANCE_FILE_NAME))).toBe(true);
  });

  it('ATB_DATA_DIR 指向自定义目录：跳过，绝不动旧目录', () => {
    const { legacy } = makeFakeHome();
    const legacyDb = writeLegacyDbAt0006(legacy);
    const custom = mkdtempSync(path.join(tmpdir(), 'atb-custom-'));
    cleanups.push(() => rmSync(custom, { recursive: true, force: true }));
    process.env.ATB_DATA_DIR = custom;

    const result = migrateLegacyDataDir();
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('显式指定');
    expect(existsSync(legacyDb)).toBe(true);
    expect(existsSync(path.join(legacy, GUIDANCE_FILE_NAME))).toBe(false);
  });

  it('失败路径：迁移脚本抛错 → 回滚新目录副本，旧目录原样可继续用旧版启动', () => {
    const { legacy, target } = makeFakeHome();
    const legacyDb = writeLegacyDbAt0006(legacy);

    // 用 ATB_MIGRATIONS_DIR 注入一套「0001~0006 完好 + 0007 必炸」的迁移目录。
    const brokenDir = mkdtempSync(path.join(tmpdir(), 'atb-broken-migrations-'));
    cleanups.push(() => rmSync(brokenDir, { recursive: true, force: true }));
    for (const migration of collectMigrations(migrationsDir()).filter((m) => m.order <= 6)) {
      mkdirSync(path.join(brokenDir, migration.name), { recursive: true });
      copyFileSync(path.join(migrationsDir(), migration.name, 'migration.sql'), path.join(brokenDir, migration.name, 'migration.sql'));
    }
    mkdirSync(path.join(brokenDir, '0007_boom'), { recursive: true });
    writeFileSync(path.join(brokenDir, '0007_boom', 'migration.sql'), 'SELECT this is not valid sql;');
    process.env.ATB_MIGRATIONS_DIR = brokenDir;

    expect(() => migrateLegacyDataDir()).toThrow(/0007_boom/);
    // 回滚：新目录不留半截库；备份按设计保留（排查用原始快照）。
    expect(existsSync(path.join(target, 'jarvis.db'))).toBe(false);
    expect(existsSync(path.join(target, 'jarvis.db-wal'))).toBe(false);
    expect(readdirSync(path.join(target, 'backups')).filter((name) => name.startsWith('atb-premigration-'))).toHaveLength(1);
    // 旧目录分毫未动 → 旧版本安装包仍可正常启动。
    expect(existsSync(legacyDb)).toBe(true);
    expect(existsSync(`${legacyDb}.migrated`)).toBe(false);
    expect(existsSync(path.join(legacy, GUIDANCE_FILE_NAME))).toBe(false);
    expect(readUserVersion(legacyDb)).toBe(6);

    // 修复脚本目录后可重跑成功（同一首启进程退出、下次启动再来，语义不变）。
    delete process.env.ATB_MIGRATIONS_DIR;
    expect(migrateLegacyDataDir().migrated).toBe(true);
    expect(readUserVersion(path.join(target, 'jarvis.db'))).toBe(8);
  });
});

function readUserVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function readStatMode(file: string): number {
  return statSync(file).mode & 0o777;
}
