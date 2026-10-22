import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { paths } from '../common/paths';

/**
 * 客户端入口的原子写：同目录临时文件 → fsync → rename。同目录是 rename 原子性的前提
 * （跨卷 rename 会退化成拷贝）。Windows 上 rename 覆盖已存在文件可能返回 EBUSY/EPERM，
 * 因此保留「重试三次」的窗口给用户关掉正在占用文件的客户端。
 */

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const RETRY_DELAYS_MS = [150, 300, 600];

export class ClientEntryFileLockedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ClientEntryFileLockedError';
  }
}

export class ClientEntryWriteFailedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ClientEntryWriteFailedError';
  }
}

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

/** 只回答「是不是占用类错误」；重试策略与错误映射留在调用方，避免平台差异扩散。 */
export function isLockError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = errnoCode(current);
    if (code !== undefined && LOCK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function existingMode(filePath: string): Promise<number> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat.mode & 0o777 : 0o644;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0o644;
    throw error;
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let tempPath: string | undefined;
    try {
      // 先读旧 mode：chmod 只保留权限位，不能把 setuid/sticky 之类带进新文件。
      const mode = await existingMode(filePath);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      tempPath = path.join(
        path.dirname(filePath),
        `.atb-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
      );
      const handle = await fsp.open(tempPath, 'w', mode);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        // open 的 mode 会被 umask 削减；显式 chmod 才能保住「已有文件 mode 不变」。
        await handle.chmod(mode);
      } finally {
        await handle.close().catch(() => undefined);
      }
      await fsp.rename(tempPath, filePath);
      return;
    } catch (error) {
      if (tempPath !== undefined) await fsp.unlink(tempPath).catch(() => undefined);
      if (!isLockError(error)) {
        throw new ClientEntryWriteFailedError(`写入客户端入口文件失败：${filePath}`, error);
      }
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new ClientEntryFileLockedError(`客户端入口文件被占用，无法写入：${filePath}`, error);
      }
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** entryId 来自数据库，但备份目录要拼进路径，先剥掉可能造成越界的字符。 */
function safeEntrySegment(entryId: string): string {
  const cleaned = String(entryId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    // 开头的点会让 `path.relative` 看起来像 `..`，也避免生成隐藏目录。
    .replace(/^\.+/, '_');
  return cleaned === '' ? '_' : cleaned;
}

function backupDir(entryId: string): string {
  return path.join(paths.backupsDir(), 'client-entries', safeEntrySegment(entryId));
}

/**
 * 文件不存在返回 null（首次安装无需备份）；备份成功后按 entry 保留最近 5 份，
 * 防止反复「重新渲染」把磁盘堆满。
 */
export function backupFile(filePath: string, entryId: string): string | null {
  try {
    fs.statSync(filePath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }

  const dir = backupDir(entryId);
  fs.mkdirSync(dir, { recursive: true });
  const basename = path.basename(filePath) || 'file';
  let stamp = Date.now();
  let target = path.join(dir, `${stamp}-${basename}`);
  // 同一毫秒内连续备份时不能互相覆盖，否则 undo 链会缺一环。
  while (fs.existsSync(target)) {
    stamp += 1;
    target = path.join(dir, `${stamp}-${basename}`);
  }
  fs.copyFileSync(filePath, target);
  pruneBackups(entryId);
  return target;
}

export function restoreBackup(backupPath: string, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(backupPath, filePath);
}

export function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export function pruneBackups(entryId: string, keep = 5): void {
  const dir = backupDir(entryId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return;
    throw error;
  }

  const files = names.filter((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
  // 文件名以 13 位时间戳开头，字典序倒排即时间倒序。
  files.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  const limit = Number.isFinite(keep) ? Math.max(0, Math.trunc(keep)) : 5;
  for (const name of files.slice(limit)) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // 备份清理是尽力而为：删不掉旧备份不该让已经成功的写入回滚。
    }
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
