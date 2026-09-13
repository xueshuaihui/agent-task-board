import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { ApiException, USER_COPY } from '../contract/errors';
import { nowSql } from '../contract/time';
import { paths } from '../common/paths';
import { applyMigrations } from '../infra/bootstrap';
import { AppLogger } from '../infra/logger';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import { assertBackupName, backupNameAt, isBackupName } from './backup-name';

export interface BackupItem {
  name: string;
  size_bytes: number;
  /** 13 章：**没有「来源」列**——文件名不携带触发方式，阶段一也只有手动备份。 */
  created_at: string;
}

export interface BackupListResult {
  items: BackupItem[];
  total_size_bytes: number;
}

export interface BackupCreated {
  name: string;
  path: string;
  size_bytes: number;
  created_at: string;
}

export interface RestoreResult {
  restored: string;
  safety_backup: string;
  tasks_failed: number;
  runs_abandoned: number;
  message: string;
}

/** 秒级文件名在同一秒内会撞车：导入自带一次备份，紧接着手点「立即备份」就会撞上。 */
const NAME_RETRY_MS = 1_050;
const NAME_RETRY_MAX = 5;

/** WAL 附属文件：主文件换掉后它们必须一起消失，否则旧页会污染新库。 */
const SIDE_SUFFIXES = ['-wal', '-shm'];

@Injectable()
export class BackupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  dir(): string {
    const dir = paths.backupsDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 9.3 方式列：`VACUUM INTO` 是只读一致性快照，**不停写**、不阻塞 Agent 回写。
   * 生成后校验大小 > 0，0 字节的空壳宁可报错也不能进列表。
   */
  async create(actorName = '我'): Promise<BackupCreated> {
    const source = paths.dbFile();
    if (!existsSync(source)) {
      throw new ApiException('INTERNAL', '数据库文件不存在，无法备份');
    }
    const dir = this.dir();
    const target = await this.freeSlot(dir);
    if (!target) {
      throw new ApiException('INTERNAL', '同一秒内已有同名备份，请一秒后再试');
    }

    try {
      this.vacuumInto(source, target);
    } catch (error) {
      rmSync(target, { force: true });
      if (error instanceof ApiException) throw error;
      throw new ApiException('INTERNAL', `备份失败：${(error as Error).message}`);
    }

    const size = statSync(target).size;
    if (size <= 0) {
      rmSync(target, { force: true });
      throw new ApiException('INTERNAL', '备份文件大小为 0，已丢弃');
    }
    const name = path.basename(target);
    await this.audit.record({
      actorType: 'user',
      actorName,
      action: 'backup',
      targetType: 'settings',
      targetId: name,
      after: { size_bytes: size, path: target },
    });
    this.logger.log(`已备份 ${target}（${size} B）`, 'backup');
    return { name, path: target, size_bytes: size, created_at: toIsoFromMtime(target) };
  }

  private async freeSlot(dir: string): Promise<string | null> {
    for (let attempt = 0; attempt < NAME_RETRY_MAX; attempt += 1) {
      const candidate = path.join(dir, backupNameAt());
      if (!existsSync(candidate)) return candidate;
      await sleep(NAME_RETRY_MS);
    }
    return null;
  }

  private vacuumInto(source: string, target: string): void {
    const db = new DatabaseSync(source);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      // VACUUM INTO 不接受占位符；target 由服务端按时间戳生成，不含任何入参。
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  }

  /** 13 章：列表来自磁盘扫描，没有 `backups` 表；按时间倒序，并给出目录总占用（阶段一不清理）。 */
  list(): BackupListResult {
    const dir = this.dir();
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      this.logger.warn(`备份目录不可读 ${dir}: ${(error as Error).message}`, 'backup');
    }
    const items: BackupItem[] = [];
    for (const entry of entries) {
      if (!isBackupName(entry)) continue;
      const file = path.join(dir, entry);
      try {
        if (!statSync(file).isFile()) continue;
        items.push({ name: entry, size_bytes: statSync(file).size, created_at: toIsoFromMtime(file) });
      } catch {
        continue;
      }
    }
    items.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return {
      items,
      total_size_bytes: items.reduce((total, item) => total + item.size_bytes, 0),
    };
  }

  /** 设置页「上次备份：今天 14:35 · 2.3 MB」用得上，省一次全列表请求。 */
  latest(): BackupItem | null {
    return this.list().items[0] ?? null;
  }

  /**
   * 9.3 恢复过程：先对当前库做安全备份 → 关写连接 → 替换 → 重新迁移建表 → 拉起。
   * 失败口径也在 9.3：替换前失败原库不动；替换后启动失败自动回滚到安全备份并输出两条路径。
   */
  async restore(name: string, actorName = '我'): Promise<RestoreResult> {
    assertBackupName(name);
    const source = path.join(this.dir(), name);
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new ApiException('BACKUP_NOT_FOUND', `备份 ${name} 不在磁盘上（可能已被手动删除）`);
    }

    // 安全备份失败即中止，原库一个字节都不动（9.3 + 原型 7.8「恢复前安全备份」）。
    const safety = await this.create('恢复前自动备份');

    const dbFile = paths.dbFile();
    const quarantine = path.join(this.dir(), '.restore-quarantine');
    const kept = path.join(quarantine, `${safety.name}.original`);
    let replaced = false;

    await this.prisma.$disconnect();
    try {
      mkdirSync(quarantine, { recursive: true });
      checkpoint(dbFile, this.logger);
      copyAside(dbFile, kept);
      copyFileSync(source, dbFile);
      replaced = true;
      // 老备份的 user_version 可能落后于当前版本：补跑迁移，新备份则是空操作。
      applyMigrations(this.logger);
      await this.prisma.$connect();
      const flipped = await this.failRunningAfterRestore();
      rmSync(quarantine, { recursive: true, force: true });
      await this.audit.record({
        actorType: 'user',
        actorName,
        action: 'restore',
        targetType: 'settings',
        targetId: name,
        before: { safety_backup: safety.name },
        after: {
          restored: name,
          tasks_failed: flipped.tasks_failed,
          runs_abandoned: flipped.runs_abandoned,
        },
      });
      this.logger.log(`已从 ${source} 恢复，安全备份在 ${safety.path}`, 'backup');
      return { restored: name, safety_backup: safety.name, ...flipped, message: USER_COPY.restoreConfirm };
    } catch (error) {
      // 9.3「替换后启动失败 → 自动回滚到安全备份并在日志中输出两条路径」。
      const rolledBackTo = this.rollback(dbFile, kept, safety.path);
      try {
        await this.prisma.$connect();
      } catch (connectError) {
        this.logger.error(
          `恢复回滚后未能重连数据库：${(connectError as Error).message}`,
          undefined,
          'backup',
        );
      }
      this.logger.error(
        `恢复 ${name} 失败，已回滚。原库副本：${replaced ? kept : '未替换，原库未动'}；安全备份：${safety.path}`,
        error instanceof Error ? error.stack : undefined,
        'backup',
      );
      if (error instanceof ApiException) throw error;
      throw new ApiException('INTERNAL', `恢复失败，已回滚到 ${rolledBackTo}`);
    }
  }

  /** 回滚优先用被换下的原库字节，退而用安全备份；两条路径都落进日志。 */
  private rollback(dbFile: string, kept: string, safetyPath: string): string {
    for (const suffix of SIDE_SUFFIXES) rmSync(dbFile + suffix, { force: true });
    rmSync(dbFile, { force: true });
    const origin = existsSync(kept) ? kept : safetyPath;
    try {
      copyFileSync(origin, dbFile);
    } catch (error) {
      this.logger.error(
        `回滚写入失败 ${origin} → ${dbFile}：${(error as Error).message}`,
        undefined,
        'backup',
      );
    }
    return origin;
  }

  /**
   * 9.3 恢复后状态：快照时刻的租约在恢复后必然已失效，RUNNING 一律落 FAILED +
   * `stop_reason = 'lease_expired'` 并清租约三列。进行中的 Run 同步置 ABANDONED（20.2），
   * 否则 `uniq_active_run` 部分唯一索引一直占位，任务此后再也认领不出去。
   */
  private async failRunningAfterRestore(): Promise<{ tasks_failed: number; runs_abandoned: number }> {
    const now = nowSql();
    const runs = await this.prisma.$executeRawUnsafe(
      `UPDATE task_runs SET status = 'ABANDONED', finished_at = ?, progress = NULL
       WHERE status = 'RUNNING'`,
      now,
    );
    const tasks = await this.prisma.$executeRawUnsafe(
      `UPDATE tasks
       SET status = 'FAILED', stop_reason = 'lease_expired',
           lease_id = NULL, lease_expires_at = NULL, current_run_id = NULL, updated_at = ?
       WHERE status = 'RUNNING'`,
      now,
    );
    return { tasks_failed: tasks, runs_abandoned: runs };
  }
}

/** 检查点失败只意味着原库副本还带着 WAL，主文件本身仍安全，因此不阻断恢复。 */
function checkpoint(dbFile: string, logger: AppLogger): void {
  try {
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn(`wal_checkpoint 失败（继续恢复）：${(error as Error).message}`, 'backup');
  }
}

function copyAside(dbFile: string, kept: string): void {
  copyFileSync(dbFile, kept);
  rmSync(dbFile + '-wal', { force: true });
  rmSync(dbFile + '-shm', { force: true });
  rmSync(dbFile, { force: true });
}

function toIsoFromMtime(file: string): string {
  return new Date(statSync(file).mtimeMs).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
