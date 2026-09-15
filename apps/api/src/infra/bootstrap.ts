import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppLogger } from './logger';
import { paths } from '../common/paths';

/**
 * 启动时自建库：按编号顺序执行 prisma/migrations/{n}_xxx/migration.sql，
 * 用 `PRAGMA user_version` 记水位。
 *
 * 为什么不跑 `prisma migrate deploy`：sidecar 是要打进安装包的单文件，
 * 拖一份 Prisma CLI 与查询引擎的迁移子命令不划算；迁移文件本身仍是唯一权威定义
 * （20.11 的「禁止运行时 ALTER」照旧成立），只是执行方从 CLI 换成了这里。
 */
export function migrationsDir(): string {
  const candidates = [
    process.env.ATB_MIGRATIONS_DIR,
    // bundle 布局（scripts/bundle-sidecar.mjs）：迁移目录与 main.js 同装进 Resources/sidecar/
    path.resolve(__dirname, 'prisma', 'migrations'),
    path.resolve(__dirname, '..', 'prisma', 'migrations'),
    path.resolve(__dirname, '..', '..', 'prisma', 'migrations'),
    path.resolve(process.cwd(), 'prisma', 'migrations'),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new Error(`找不到迁移目录，尝试过：\n${candidates.join('\n')}`);
  }
  return found;
}

interface PendingMigration {
  order: number;
  name: string;
  sql: string;
}

export function collectMigrations(dir = migrationsDir()): PendingMigration[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
    .map((entry) => {
      const file = path.join(dir, entry.name, 'migration.sql');
      if (!existsSync(file)) throw new Error(`${entry.name} 缺少 migration.sql`);
      return {
        order: Number(entry.name.split('_')[0]),
        name: entry.name,
        sql: readFileSync(file, 'utf8'),
      };
    })
    .sort((a, b) => a.order - b.order);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

/**
 * 水位对齐（2026-09-15 真机验收缺陷 #2）：`scripts/db.mjs`（开发期 `prisma migrate deploy`）
 * 建的库没有 `user_version` 水位（账本在 `_prisma_migrations` 表），shared 数据目录下
 * 首次用本机制启动会误判为空库、重放 0001_init 撞表。
 * 判据：version==0 且 `tasks` 表已存在 → 不是空库，按 `_prisma_migrations` 账本对齐水位；
 * 无账本的既有库（来源不明）对齐到当前全量水位——前提是其 schema 与当前迁移同代，
 * 跨代升级需要在这里补充显式判定，不允许静默跳迁移。
 */
function alignLegacyWatermark(db: DatabaseSync, migrations: PendingMigration[]): number {
  if (!tableExists(db, 'tasks')) return 0;
  if (tableExists(db, '_prisma_migrations')) {
    const rows = db
      .prepare(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      )
      .all() as Array<{ migration_name?: string }>;
    const applied = new Set(rows.map((row) => row.migration_name).filter(Boolean));
    const matched = migrations.filter((migration) => applied.has(migration.name));
    if (matched.length > 0) return Math.max(...matched.map((migration) => migration.order));
  }
  return Math.max(...migrations.map((migration) => migration.order));
}

export function applyMigrations(logger?: Pick<AppLogger, 'log' | 'error'>): number[] {
  mkdirSync(paths.dataDir(), { recursive: true });
  mkdirSync(paths.artifactsDir(), { recursive: true });
  mkdirSync(paths.backupsDir(), { recursive: true });
  mkdirSync(paths.logsDir(), { recursive: true });

  const db = new DatabaseSync(paths.dbFile());
  const applied: number[] = [];
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number };
    let version = Number(row?.user_version ?? 0);
    const migrations = collectMigrations();
    if (version === 0) {
      const aligned = alignLegacyWatermark(db, migrations);
      if (aligned > 0) {
        version = aligned;
        db.exec(`PRAGMA user_version = ${aligned}`);
        logger?.log(`检测到既有库（schema 已存在、无水位），迁移水位对齐为 ${aligned}`);
      }
    }
    for (const migration of migrations) {
      if (migration.order <= version) continue;
      db.exec('BEGIN');
      try {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.order}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw new Error(`迁移 ${migration.name} 失败：${(error as Error).message}`);
      }
      version = migration.order;
      applied.push(migration.order);
      logger?.log(`已应用迁移 ${migration.name}`);
    }
  } finally {
    db.close();
  }
  return applied;
}

/** 备份/恢复要用同一个库文件的句柄语义，这里只暴露路径检查。 */
export function databaseExists(): boolean {
  return existsSync(paths.dbFile());
}
