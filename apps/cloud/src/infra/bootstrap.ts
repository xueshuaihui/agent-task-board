import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaService } from './prisma.service';
import { paths } from '../common/paths';

/**
 * 启动自建库：按编号顺序执行 prisma/migrations/{n}_xxx/migration.sql。
 * 水位记在 `_cloud_migrations` 表（不依赖 Prisma CLI；部署态没有引擎迁移子命令）。
 */
export function migrationsDir(): string {
  const candidates = [
    process.env.CLOUD_MIGRATIONS_DIR,
    path.resolve(__dirname, 'prisma', 'migrations'),
    path.resolve(__dirname, '..', 'prisma', 'migrations'),
    path.resolve(__dirname, '..', '..', 'prisma', 'migrations'),
    path.resolve(process.cwd(), 'prisma', 'migrations'),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((dir) => {
    try {
      return readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(`找不到迁移目录，尝试过：\n${candidates.join('\n')}`);
  }
  return found;
}

function collectMigrations(dir: string): { order: number; name: string; sql: string }[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
    .map((entry) => {
      const file = path.join(dir, entry.name, 'migration.sql');
      return { order: Number(entry.name.split('_')[0]), name: entry.name, sql: readFileSync(file, 'utf8') };
    })
    .sort((a, b) => a.order - b.order);
}

/**
 * Prisma 的 $executeRawUnsafe 一次只接受一条语句；迁移文件是可读性优先的多语句脚本，
 * 这里按 `;` 拆分执行。约定：迁移 SQL 内不出现含 `;` 的字符串字面量（CHECK 词表除外）。
 */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function applyMigrations(prisma: PrismaService): Promise<string[]> {
  // 库文件所在目录必须先建好，否则 SQLite 报 "Unable to open the database file"。
  mkdirSync(paths.dataDir(), { recursive: true });
  const dir = migrationsDir();
  const migrations = collectMigrations(dir);
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS _cloud_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  );
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM _cloud_migrations`);
  const applied = new Set(rows.map((row) => row.name));
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    for (const statement of splitStatements(migration.sql)) {
      await prisma.$executeRawUnsafe(statement);
    }
    await prisma.$executeRawUnsafe(`INSERT INTO _cloud_migrations (name) VALUES (?)`, migration.name);
    ran.push(migration.name);
  }
  return ran;
}
