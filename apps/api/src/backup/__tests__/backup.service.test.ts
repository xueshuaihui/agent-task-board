import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiException, USER_COPY } from '../../contract/errors';
import { nowSql } from '../../contract/time';
import { paths } from '../../common/paths';
import { backupNameAt } from '../backup-name';
import type { BackupItem } from '../backup.service';
import {
  createBackupHarness,
  seedArtifactFile,
  seedArtifactRow,
  seedRunning,
  seedSnapshot,
  writeJunk,
  type BackupHarness,
} from './temp-db';

/**
 * 9.3 备份 / 恢复。三条不能退让的口径：
 * 1. `{name}` 校验在拼路径之前（15 章硬约束）；
 * 2. 列表只认文件名形状，没有「来源」列；
 * 3. 恢复把快照时刻执行中的任务全部转为失败，产物文件不在范围内。
 */

let h: BackupHarness;

beforeAll(() => {
  h = createBackupHarness('atb-backup-');
});

afterEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h.dispose();
});

async function thrown(promise: Promise<unknown>): Promise<ApiException> {
  return promise.then(
    () => {
      throw new Error('预期抛出 ApiException，但调用成功了');
    },
    (error: ApiException) => error,
  );
}

/** 直接读备份文件里的表，判断这份快照到底是哪一刻的。 */
function titlesIn(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT title FROM tasks ORDER BY id').all() as { title: string }[]).map((row) => row.title);
  } finally {
    db.close();
  }
}

/**
 * 写一个备份形状的假文件，并把 mtime 摆成文件名里那个时刻。
 * `list()` 的 `created_at` 取 mtime 而非文件名，同一秒写进来的三个文件会退化成 readdir 顺序，
 * 所以任何断言先后的用例都得显式设时间——光靠文件名不够。
 */
function junkAt(name: string, body = 'junk'): void {
  const file = path.join(paths.backupsDir(), name);
  writeJunk(file, body);
  const at = new Date(
    name.replace(/^atb-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/, '$1-$2-$3T$4:$5:$6Z'),
  );
  utimesSync(file, at, at);
}

describe('立即备份（VACUUM INTO）', () => {
  it('文件名就是 atb-YYYYMMDD-HHmmss.db，落在 backups 目录里，字节非空', async () => {
    await seedSnapshot(h.prisma, 'A');
    const created = await h.backups.create();

    expect(created.name).toMatch(/^atb-\d{8}-\d{6}\.db$/);
    expect(created.name).toBe(backupNameAt());
    expect(created.path).toBe(path.join(paths.backupsDir(), created.name));
    expect(created.size_bytes).toBeGreaterThan(0);
    expect(statSync(created.path).size).toBe(created.size_bytes);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(titlesIn(created.path)).toEqual(['任务 A']);
  });

  it('备份不停写、也不清空当前库：备份完读写的还是原实例', async () => {
    await seedSnapshot(h.prisma, 'A');
    await h.backups.create();

    expect(await h.prisma.task.count()).toBe(1);
    expect(existsSync(paths.dbFile())).toBe(true);
    // 备份文件与主库是两个 inode：`VACUUM INTO` 不是复制文件句柄
    expect(readdirSync(paths.backupsDir())).toHaveLength(1);
  });

  it('落一条 backup 审计：targetId 是文件名，after 带大小与路径', async () => {
    const created = await h.backups.create('张三');
    const audit = await h.prisma.auditLog.findFirst({ where: { action: 'backup' } });

    expect(audit).toMatchObject({ actorType: 'user', actorName: '张三', targetType: 'settings', targetId: created.name });
    expect(JSON.parse(audit?.after ?? '{}')).toEqual({ size_bytes: created.size_bytes, path: created.path });
  });

  it('同一秒内已有同名备份时不覆盖：等一秒换下一个号位，两份文件都在', async () => {
    await seedSnapshot(h.prisma, '第一份');
    const first = await h.backups.create();
    await h.prisma.task.update({ where: { id: 'T-第一份' }, data: { title: '改过了' } });
    const second = await h.backups.create();

    expect(second.name).not.toBe(first.name);
    expect(readdirSync(paths.backupsDir()).sort()).toEqual([first.name, second.name].sort());
    expect(titlesIn(first.path)).toEqual(['任务 第一份']);
    expect(titlesIn(second.path)).toEqual(['改过了']);
  });

  it('主库文件不存在时报 INTERNAL，不留下 0 字节空壳', async () => {
    const missing = createBackupHarness('atb-backup-nolib-');
    rmSync(paths.dbFile(), { force: true });
    const error = await thrown(missing.backups.create());
    expect({ code: error.code, status: error.status }).toEqual({ code: 'INTERNAL', status: 500 });
    expect(readdirSync(paths.backupsDir())).toEqual([]);
    await missing.prisma.$disconnect();
    rmSync(missing.dir, { force: true, recursive: true });
    process.env.ATB_DATA_DIR = h.dir;
  });
});

describe('备份列表（磁盘扫描，没有 backups 表）', () => {
  it('只认文件名形状：目录、错后缀、多余前后缀、临时文件都不进列表', async () => {
    const dir = paths.backupsDir();
    writeJunk(path.join(dir, 'atb-20260901-050607.db'));
    writeJunk(path.join(dir, 'atb-20260901-050607.db-wal'));
    writeJunk(path.join(dir, 'atb-20260901-050607.sql'));
    writeJunk(path.join(dir, 'notes.txt'));
    writeJunk(path.join(dir, '.DS_Store'));
    writeJunk(path.join(dir, 'atb-2026090-050607.db'));
    mkdirSync(path.join(dir, 'atb-20250101-000000.db'), { recursive: true });

    const list = h.backups.list();
    expect(list.items.map((item) => item.name)).toEqual(['atb-20260901-050607.db']);
    expect(list.total_size_bytes).toBe(4);
  });

  it('每一项只有 name / size_bytes / created_at 三个键——没有「来源」列', async () => {
    await h.backups.create();
    const list = h.backups.list();

    expect(list.items).toHaveLength(1);
    expect(Object.keys(list.items[0] as BackupItem).sort()).toEqual(['created_at', 'name', 'size_bytes']);
    expect(Object.keys(list).sort()).toEqual(['items', 'total_size_bytes']);
    expect(JSON.stringify(list)).not.toMatch(/source|origin|来源|actor|kind|trigger/);
  });

  it('按时间倒序，总占用等于各项之和', async () => {
    junkAt('atb-20260901-000001.db', 'aaaa');
    junkAt('atb-20260902-000000.db', 'bb');
    junkAt('atb-20260903-000000.db', 'c');

    const list = h.backups.list();
    expect(list.items.map((item) => item.size_bytes)).toEqual([1, 2, 4]);
    expect(list.total_size_bytes).toBe(7);
    // 文件名与 mtime 都被设成同一时刻，倒序必须稳定体现在 created_at 上
    expect(list.items.map((item) => item.created_at)).toEqual([...list.items.map((item) => item.created_at)].sort().reverse());
  });

  it('latest() 给最新一条，空目录给出空列表与 null', async () => {
    expect(h.backups.list()).toEqual({ items: [], total_size_bytes: 0 });
    expect(h.backups.latest()).toBeNull();

    const created = await h.backups.create();
    expect(h.backups.latest()?.name).toBe(created.name);
    // 目录被顺手建出来，设置页第一次进就能列出空数组
    expect(readdirSync(paths.backupsDir())).toEqual([created.name]);
  });

  it('controller 侧多带一个 backup_dir，其余原样', async () => {
    const created = await h.backups.create();
    const { BackupController } = await import('../backup.controller');
    const body = new BackupController(h.backups).list();

    expect(body.backup_dir).toBe(paths.backupsDir());
    expect(body.items.map((item) => item.name)).toEqual([created.name]);
  });
});

describe('恢复：非法名字必须先于路径拼接被拒（15 章硬约束）', () => {
  /** 一个真的、形状合法、可被恢复的备份，放在 backups 目录的**上一级**。 */
  async function poison(): Promise<{ name: string; file: string }> {
    const name = backupNameAt(new Date(2026, 8, 1, 5, 6, 7));
    const file = path.join(paths.dataDir(), name);
    writeJunk(file, readFileSync(await snapshotOf()));
    return { name, file };
  }

  async function snapshotOf(): Promise<string> {
    const created = await h.backups.create();
    return created.path;
  }

  it('拼上去确实能找到文件的 ../ 名字，仍然得到 400 而不是读它', async () => {
    await seedSnapshot(h.prisma, 'A');
    const { name, file } = await poison();
    const traversal = `../${name}`;
    // 前提：如果先 join 再校验，这个路径是真的存在、真的能恢复
    expect(path.join(paths.backupsDir(), traversal)).toBe(file);
    expect(existsSync(path.join(paths.backupsDir(), traversal))).toBe(true);
    // poison() 自己造过一次快照，所以目录非空是预期：要比的是「恢复这一下没有新增文件」。
    const dirBefore = readdirSync(paths.backupsDir());

    const error = await thrown(h.backups.restore(traversal));
    expect({ code: error.code, status: error.status }).toEqual({ code: 'INVALID_BACKUP_NAME', status: 400 });
    // 钉死「校验在拼路径之前」：连恢复前的安全备份都没发生
    expect(readdirSync(paths.backupsDir())).toEqual(dirBefore);
    expect(readFileSync(file, 'utf8')).not.toBe('junk');
    expect(existsSync(file)).toBe(true);
    expect(await h.prisma.task.findUnique({ where: { id: 'T-A' } })).toMatchObject({ title: '任务 A' });
  });

  it('绝对路径与子目录名字同样在拼路径之前被拒', async () => {
    await seedSnapshot(h.prisma, 'A');
    const created = await h.backups.create();

    for (const name of [created.path, `${paths.backupsDir()}/${created.name}`, `../backups/${created.name}`]) {
      const error = await thrown(h.backups.restore(name));
      expect({ name, code: error.code, status: error.status }).toEqual({
        name,
        code: 'INVALID_BACKUP_NAME',
        status: 400,
      });
    }
    // 一次都没恢复：数据与备份目录都不动
    expect(await h.prisma.task.findUnique({ where: { id: 'T-A' } })).toMatchObject({ title: '任务 A' });
    expect(readdirSync(paths.backupsDir())).toEqual([created.name]);
  });

  it('名字合法但文件不存在 → BACKUP_NOT_FOUND 404，且不做安全备份', async () => {
    await seedSnapshot(h.prisma, 'A');
    const error = await thrown(h.backups.restore('atb-20250101-000000.db'));

    expect({ code: error.code, status: error.status }).toEqual({ code: 'BACKUP_NOT_FOUND', status: 404 });
    expect(error.message).toContain('atb-20250101-000000.db');
    expect(readdirSync(paths.backupsDir())).toEqual([]);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('名字合法、但那是个目录 → 同样按不存在处理，不拿目录去替换库', async () => {
    const name = backupNameAt(new Date(2025, 0, 1, 0, 0, 0));
    mkdirSync(path.join(paths.backupsDir(), name), { recursive: true });

    const error = await thrown(h.backups.restore(name));
    expect({ code: error.code, status: error.status }).toEqual({ code: 'BACKUP_NOT_FOUND', status: 404 });
    expect(existsSync(paths.dbFile())).toBe(true);
  });
});

describe('恢复：吃进 tasks / runs / reviews / audit，产物文件不在范围内', () => {
  it('快照之后的改动全部回退，四类数据都按快照覆盖', async () => {
    await seedSnapshot(h.prisma, 'A');
    const artifact = seedArtifactFile('T-A', 'R-A', 'SENTINEL-产物字节');
    await seedArtifactRow(h.prisma, 'T-A', 'R-A', artifact.uri);
    const snapshot = await h.backups.create();

    // 快照之后：改标题、加任务、删审核、写审计、再删掉一个产物文件
    await h.prisma.task.update({ where: { id: 'T-A' }, data: { title: '改过了', status: 'DONE' } });
    await seedSnapshot(h.prisma, 'B');
    await h.prisma.review.deleteMany();
    await h.prisma.auditLog.create({
      data: { actorType: 'user', actorName: '我', action: 'task_delete', targetType: 'task', targetId: 'T-B' },
    });
    await h.prisma.artifact.deleteMany();
    rmSync(artifact.file, { force: true });
    expect(await h.prisma.task.count()).toBe(2);

    const result = await h.backups.restore(snapshot.name);

    expect(result.restored).toBe(snapshot.name);
    expect(result.message).toBe(USER_COPY.restoreConfirm);
    expect(result.safety_backup).not.toBe(snapshot.name);
    expect(result.safety_backup).toMatch(/^atb-\d{8}-\d{6}\.db$/);
    expect(result.tasks_failed).toBe(0);
    expect(result.runs_abandoned).toBe(0);

    expect(await h.prisma.task.findUnique({ where: { id: 'T-A' } })).toMatchObject({ title: '任务 A', status: 'REVIEW' });
    expect(await h.prisma.task.findUnique({ where: { id: 'T-B' } })).toBeNull();
    expect(await h.prisma.taskRun.findMany()).toHaveLength(1);
    expect(await h.prisma.review.findMany()).toMatchObject([{ id: 'rev-A', conclusion: 'APPROVE' }]);
    // 审计日志在备份范围内（与 6.12.1 的导出不是一回事）。
    // 恢复前的那笔安全备份记在「被换掉的库」里，跟着旧库一起消失；它的痕迹是 restore 行的 before.safety_backup。
    const auditRows = await h.prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(auditRows.map((row) => row.action)).toEqual(['task_update', 'restore']);
    expect(JSON.parse(String(auditRows[1]?.before)).safety_backup).toBe(result.safety_backup);
    // 产物行跟着回来了，但它指向的文件不会从备份里长出来
    expect(await h.prisma.artifact.findFirst({})).toMatchObject({ uri: artifact.uri });
    expect(existsSync(artifact.file)).toBe(false);
  });

  it('产物目录整体不受恢复影响：没删的文件字节与 mtime 都不动', async () => {
    await seedSnapshot(h.prisma, 'A');
    const kept = seedArtifactFile('T-A', 'R-A', 'SENTINEL-留下不动');
    await seedArtifactRow(h.prisma, 'T-A', 'R-A', kept.uri);
    const snapshot = await h.backups.create();

    const before = { mtimeMs: statSync(kept.file).mtimeMs, bytes: readFileSync(kept.file, 'utf8') };
    await h.prisma.task.update({ where: { id: 'T-A' }, data: { title: '改过了' } });
    await h.backups.restore(snapshot.name);

    expect({ mtimeMs: statSync(kept.file).mtimeMs, bytes: readFileSync(kept.file, 'utf8') }).toEqual(before);
    expect(readdirSync(path.dirname(kept.file)).length).toBe(1);
  });

  it('快照里执行中的任务在恢复后全部转为失败，Run 置 ABANDONED 并清掉租约', async () => {
    await seedSnapshot(h.prisma, 'A');
    await seedRunning(h.prisma, 'T-A', 'R-A-2');
    const snapshot = await h.backups.create();

    await h.prisma.task.update({ where: { id: 'T-A' }, data: { status: 'DONE', leaseId: null, currentRunId: null } });
    const result = await h.backups.restore(snapshot.name);

    expect({ tasks_failed: result.tasks_failed, runs_abandoned: result.runs_abandoned }).toEqual({
      tasks_failed: 1,
      runs_abandoned: 1,
    });
    const task = await h.prisma.task.findUnique({ where: { id: 'T-A' } });
    expect(task).toMatchObject({ status: 'FAILED', stopReason: 'lease_expired' });
    expect({ leaseId: task?.leaseId, leaseExpiresAt: task?.leaseExpiresAt, currentRunId: task?.currentRunId }).toEqual({
      leaseId: null,
      leaseExpiresAt: null,
      currentRunId: null,
    });
    // 快照时刻的租约在恢复后必然已失效：claimed_at 留着当历史，进度清零
    expect(task?.claimedAt).not.toBeNull();
    const run = await h.prisma.taskRun.findUnique({ where: { id: 'R-A-2' } });
    expect(run).toMatchObject({ status: 'ABANDONED', progress: null });
    expect(run?.finishedAt).not.toBeNull();
    // 快照里那条已完成的 Run 不受牵连
    expect(await h.prisma.taskRun.findUnique({ where: { id: 'R-A' } })).toMatchObject({ status: 'SUCCESS' });
  });

  it('恢复落一条 restore 审计，before 里带着安全备份的名字', async () => {
    await seedSnapshot(h.prisma, 'A');
    const snapshot = await h.backups.create();
    const result = await h.backups.restore(snapshot.name, '李四');

    const audit = await h.prisma.auditLog.findFirst({ where: { action: 'restore' } });
    expect(audit).toMatchObject({ actorType: 'user', actorName: '李四', targetType: 'settings', targetId: snapshot.name });
    expect(JSON.parse(audit?.before ?? '{}')).toEqual({ safety_backup: result.safety_backup });
    expect(JSON.parse(audit?.after ?? '{}')).toEqual({
      restored: snapshot.name,
      tasks_failed: 0,
      runs_abandoned: 0,
    });
  });

  it('替换后启动失败：自动回滚，日志里两条路径都在', async () => {
    await seedSnapshot(h.prisma, 'A');
    const snapshot = await h.backups.create();
    // 伪造一份名字合法、内容不是数据库的文件（9.3「替换后启动失败 → 自动回滚」）
    const forged = 'atb-20250102-000000.db';
    writeJunk(path.join(paths.backupsDir(), forged), '这不是数据库文件');

    const error = await thrown(h.backups.restore(forged));
    expect({ code: error.code, status: error.status }).toEqual({ code: 'INTERNAL', status: 500 });
    expect(error.message).toContain('已回滚');

    // 回滚到原库：恢复前的数据仍然在
    expect(await h.prisma.task.findUnique({ where: { id: 'T-A' } })).toMatchObject({ title: '任务 A' });

    const messages = h.logger.error.mock.calls.map((call) => String(call[0]));
    const line = messages.find((msg) => msg.includes('已回滚')) ?? '';
    // 被换下的原库副本留在隔离目录里，安全备份是这次恢复临时生成的另一份文件
    const safety = readdirSync(paths.backupsDir()).find(
      (entry) => ![snapshot.name, forged].includes(entry) && /^atb-\d{8}-\d{6}\.db$/.test(entry),
    );
    expect(line).toContain('.restore-quarantine');
    expect(safety).toEqual(expect.any(String));
    expect(line).toContain(String(safety));
    expect(existsSync(snapshot.path)).toBe(true);
  });
});
