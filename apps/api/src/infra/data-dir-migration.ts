import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDataDir, legacyDataDir, paths } from '../common/paths';
import { applyMigrations } from './bootstrap';

/**
 * v0.0.4 W1b（需求.md §21.1「数据目录迁移」+ §21.2 迁移约束）：
 * 升级后首次启动时，把 v0.0.3 的默认数据目录 `~/.agent-board`（SQLite 为 `atb.db`）
 * 一次性自动搬迁到 `~/.jarvis-workbench`（SQLite 为 `jarvis.db`）。
 *
 * 为什么放在 api 侧 bootstrap（而不是桌面端 Rust）：
 * 1. 搬迁的收尾动作是「schema 补到 0008 + 写 `settings.migrated_from` + 记
 *    `migration.completed` 审计」，三者都要操作 SQLite——迁移机制（bootstrap.applyMigrations）
 *    和库表定义本来就在这侧，Rust 再实现一遍就是双口径；
 * 2. 桌面端唯一要做的是把默认目录名改齐（paths.rs），它注入的 `ATB_DATA_DIR` 与新默认值
 *    相等，本模块据此判断「这是默认目录，可以搬」；用户显式指到自定义目录时跳过；
 * 3. sidecar 起不来时桌面端只会弹「启动失败」，把逻辑放 Rust 并不会让失败路径更体面。
 *
 * 顺序与失败语义（§21.2-1「先整库备份，任一脚本失败即回滚并保持旧版可正常启动」）：
 *   备份到 `backups/` → 复制库（含 -wal/-shm）到新目录并在**副本**上 checkpoint →
 *   校验 `integrity_check` → `applyMigrations`（0007/0008 随水位自动续跑）→
 *   写 migrated_from + 审计 → 旧目录留只读指引文件 → 旧库改名 `atb.db.migrated` 封存。
 * 前四步任一失败：删掉新目录里本次复制出来的库文件（备份保留），旧目录分毫未动，
 * 旧版本安装包仍可正常启动；异常照旧上抛让 main.ts 记日志退出，不带病起服务。
 * 「搬迁」选择复制而非移动：旧目录整库封存（改名即失联），失败回滚才是不删任何东西。
 */

/** §21.2-3：迁移完成后写入 `settings.migrated_from = 'v0.0.3'`（20.9 口径：value 是 JSON 文本）。 */
export const MIGRATED_FROM_KEY = 'migrated_from';
export const MIGRATED_FROM_VALUE = JSON.stringify('v0.0.3');
/** §21.2-3 的审计动作名（本表动作名统一 snake_case，对应 PRD 的 `migration.completed`）。 */
export const MIGRATION_AUDIT_ACTION = 'migration_completed';
/** §21.1「旧位置留只读指引文件」。 */
export const GUIDANCE_FILE_NAME = 'MIGRATED.md';
/** 搬迁成功后旧库的封存名：防止旧版本安装包继续写一份分叉数据（§21.2-2 迁移不可逆）。 */
export const SEALED_DB_SUFFIX = '.migrated';

export interface DataDirMigrationResult {
  migrated: boolean;
  /** 未搬迁时的原因（幂等跳过 / 自定义目录 / 无旧库）。 */
  reason?: string;
  backupFile?: string;
}

interface LoggerLike {
  log(message: unknown, context?: string): void;
  error(message: unknown, trace?: string, context?: string): void;
}

export function migrateLegacyDataDir(logger?: LoggerLike): DataDirMigrationResult {
  const target = paths.dataDir();
  // 主进程注入的 ATB_DATA_DIR 与新默认值同源（paths.rs 的 data_dir()），只有「就住在默认
  // 目录」的安装才需要搬迁；用户显式指到别处时尊重之，不动旧目录。
  if (path.resolve(target) !== path.resolve(defaultDataDir())) {
    return { migrated: false, reason: `数据目录被显式指定为 ${target}，跳过默认目录搬迁` };
  }
  const legacy = legacyDataDir();
  const legacyDb = path.join(legacy, 'atb.db');
  if (!existsSync(legacyDb)) {
    // 注意：本模块成功后旧库会被改名为 atb.db.migrated，所以「重复执行」天然走这条跳过分支。
    return { migrated: false, reason: existsSync(path.join(legacy, GUIDANCE_FILE_NAME)) ? '旧目录已留指引文件，视为已搬迁' : '未发现旧位置数据库，无需搬迁' };
  }
  if (existsSync(paths.dbFile())) {
    // 新目录已有库（旧版 sidecar 曾在旧默认目录之外抢跑、或手工恢复过备份）：不覆盖现场，
    // 只补留指引文件，把矛盾留给用户按备份处置。
    writeGuidanceFile(legacy, '（跳过：新数据目录已存在 jarvis.db，未覆盖）');
    return { migrated: false, reason: '新数据目录已存在 jarvis.db，不覆盖现场' };
  }

  logger?.log(`检测到 v0.0.3 数据目录 ${legacy}，开始一次性搬迁至 ${target}`, 'boot');
  mkdirSync(target, { recursive: true });
  mkdirSync(paths.artifactsDir(), { recursive: true });
  mkdirSync(paths.backupsDir(), { recursive: true });

  // 1) 先整库备份（§21.2-1）。备份先于任何复制动作，失败路径也保证有原始快照可恢复。
  const backupFile = path.join(paths.backupsDir(), `atb-premigration-${timestamp()}.db`);
  copyFileSync(legacyDb, backupFile);

  // 2) 复制库（含 -wal/-shm sidecar 文件）到新目录。checkpoint 只跑在副本上——旧库全程零写入。
  copyFileSync(legacyDb, paths.dbFile());
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(legacyDb + suffix)) copyFileSync(legacyDb + suffix, paths.dbFile() + suffix);
  }
  // 3) 随带运行期文件：config.json（生效端口）、window-state.json（窗口记忆）只在新目录
  // 没有同名文件时补拷——主进程可能已在首启时往新目录写过更新的端口，不能反向覆盖。
  copyIfAbsent(path.join(legacy, 'config.json'), path.join(target, 'config.json'));
  copyIfAbsent(path.join(legacy, 'window-state.json'), path.join(target, 'window-state.json'));
  // 目录逐文件并入（force:false = 不覆盖新目录已有同名文件）：artifacts/backups 都是
  // 「先到的保留」语义，搬迁不允许吃掉任何一侧的内容。
  copyDirMerge(path.join(legacy, 'artifacts'), paths.artifactsDir());
  copyDirMerge(path.join(legacy, 'backups'), paths.backupsDir());

  try {
    checkpointAndVerify();
    // 4) 补 schema：旧库停在 0006，bootstrap 的水位机制会把 0007/0008 续上（同一次启动里
    //    main.ts 稍后还会再调一遍 applyMigrations，届时水位已到头，是幂等空转）。
    const applied = applyMigrations(logger);
    recordMigrationAudit(legacy, target, backupFile, applied);
  } catch (error) {
    // 回滚：删掉本次复制出来的库（含 sidecar 文件），旧目录未动 → 旧版仍可正常启动；
    // 备份保留在 backups/ 供排查。异常上抛，让 main.ts 以「启动失败」收口。
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(paths.dbFile() + suffix, { force: true });
    }
    logger?.error(
      `数据目录搬迁失败，已回滚（旧目录 ${legacy} 未改动，可用旧版本继续启动）：${(error as Error).message}`,
      undefined,
      'boot',
    );
    throw error;
  }

  // 5) 旧位置留只读指引文件，再把旧库封存改名（顺序不能反：指引没落地前旧库不许失联）。
  writeGuidanceFile(legacy, backupFile);
  try {
    renameSync(legacyDb, legacyDb + SEALED_DB_SUFFIX);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(legacyDb + suffix)) renameSync(legacyDb + suffix, legacyDb + SEALED_DB_SUFFIX + suffix);
    }
  } catch (error) {
    // 封存失败不回滚：新库已就绪且带审计，旧库留着只可能误导旧版本，记日志即可。
    logger?.error(`旧库封存改名失败（不影响新目录使用）：${(error as Error).message}`, undefined, 'boot');
  }
  logger?.log(`数据目录搬迁完成：${legacy} → ${target}，备份 ${backupFile}`, 'boot');
  return { migrated: true, backupFile };
}

/** 在副本上合并 WAL 并做完整性校验；失败抛错交给上层回滚。 */
function checkpointAndVerify(): void {
  const db = new DatabaseSync(paths.dbFile());
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (row?.integrity_check !== 'ok') {
      throw new Error(`复制出的库未通过 integrity_check：${String(row?.integrity_check)}`);
    }
  } finally {
    db.close();
  }
}

/** §21.2-3：`settings.migrated_from = 'v0.0.3'` + 一条 `migration.completed` 审计。 */
function recordMigrationAudit(
  legacy: string,
  target: string,
  backupFile: string,
  applied: number[],
): void {
  const db = new DatabaseSync(paths.dbFile());
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(MIGRATED_FROM_KEY, MIGRATED_FROM_VALUE);
      db.prepare(
        `INSERT INTO audit_logs (actor_type, actor_name, action, target_type, target_id, before, after)
         VALUES ('system', 'data-dir-migration', ?, 'data', 'data_dir', ?, ?)`,
      ).run(
        MIGRATION_AUDIT_ACTION,
        JSON.stringify({ data_dir: legacy, db: path.join(legacy, 'atb.db') }),
        JSON.stringify({ data_dir: target, db: paths.dbFile(), backup: backupFile, applied_migrations: applied }),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

function writeGuidanceFile(legacy: string, backupFile: string): void {
  const file = path.join(legacy, GUIDANCE_FILE_NAME);
  if (existsSync(file)) return;
  const body = [
    '# 数据目录已迁移（v0.0.4）',
    '',
    '本目录是 Jarvis Workbench v0.0.3 及更早版本的数据目录，升级后首次启动时已一次性搬迁至：',
    '',
    `    ${defaultDataDir()}`,
    '',
    '- 数据库：`atb.db` → `jarvis.db`（旧库已改名封存为 `atb.db' + SEALED_DB_SUFFIX + '`，不再被任何版本读写）',
    `- 迁移前的整库备份：${backupFile}`,
    '- 本文件只读、仅作指引；请不要再从本目录启动旧版本。',
    '',
    '迁移不可逆（需求.md §21.2-2）：不提供回退开关，降级只能「恢复备份 + 旧安装包」。',
    '',
  ].join('\n');
  writeFileSync(file, body, { flag: 'wx' });
  try {
    chmodSync(file, 0o444); // 「只读指引文件」：同机其他进程也改不动它。
  } catch {
    // Windows 上没有 POSIX 读语义，写成功即达成指引目的。
  }
}

function copyIfAbsent(from: string, to: string): void {
  if (existsSync(from) && !existsSync(to)) copyFileSync(from, to);
}

function copyDirMerge(from: string, to: string): void {
  if (existsSync(from)) cpSync(from, to, { recursive: true, force: false });
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
