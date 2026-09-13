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
    for (const migration of collectMigrations()) {
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
