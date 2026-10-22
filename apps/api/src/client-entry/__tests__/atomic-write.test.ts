import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths } from '../../common/paths';
import {
  backupFile,
  ClientEntryWriteFailedError,
  isLockError,
  pruneBackups,
  readFileIfExists,
  restoreBackup,
  sha256,
  writeFileAtomic,
} from '../atomic-write';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-client-entry-atomic-'));
const previousDataDir = process.env.ATB_DATA_DIR;

beforeAll(() => {
  // 备份目录跟随 ATB_DATA_DIR；用例绝不写真实数据目录。
  process.env.ATB_DATA_DIR = path.join(root, 'data');
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.ATB_DATA_DIR;
  else process.env.ATB_DATA_DIR = previousDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('writeFileAtomic', () => {
  it('自动创建目录，写入后回读一致，且不留下临时文件', async () => {
    const file = path.join(root, 'writes', 'nested', 'file.md');
    await writeFileAtomic(file, 'hello\nworld');
    expect(readFileIfExists(file)).toBe('hello\nworld');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['file.md']);
  });

  it('覆盖已有文件', async () => {
    const file = path.join(root, 'overwrite', 'file.md');
    await writeFileAtomic(file, 'v1');
    await writeFileAtomic(file, 'v2');
    expect(readFileIfExists(file)).toBe('v2');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['file.md']);
  });

  it.skipIf(process.platform === 'win32')('保留已有文件 mode，新文件为 0o644', async () => {
    const file = path.join(root, 'mode', 'file.md');
    await writeFileAtomic(file, 'v1');
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);

    fs.chmodSync(file, 0o600);
    await writeFileAtomic(file, 'v2');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('其它 IO 错误包成 ClientEntryWriteFailedError 并保留 cause', async () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not a directory', 'utf8');
    const failure = await writeFileAtomic(path.join(blocker, 'child.md'), 'x').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ClientEntryWriteFailedError);
    expect((failure as Error & { cause?: NodeJS.ErrnoException }).cause?.code).toBeDefined();
  });

  it('rename 失败时清理同目录临时文件', async () => {
    const dir = path.join(root, 'rename-fail');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'file.md');
    const boom = errno('EIO');
    const spy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(boom);
    let failure: unknown;
    try {
      await writeFileAtomic(file, 'x');
    } catch (error) {
      failure = error;
    } finally {
      spy.mockRestore();
    }
    expect(failure).toBeInstanceOf(ClientEntryWriteFailedError);
    expect((failure as Error & { cause?: unknown }).cause).toBe(boom);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('备份与还原', () => {
  it('备份到 backups/client-entries/<entryId>/<ts>-<basename>，可还原', async () => {
    const file = path.join(root, 'backup', 'file.md');
    await writeFileAtomic(file, 'v1');
    const backup = backupFile(file, 'entry-a');
    expect(backup).not.toBeNull();
    if (backup === null) throw new Error('expected backup');
    expect(backup.startsWith(path.join(paths.backupsDir(), 'client-entries', 'entry-a'))).toBe(
      true,
    );
    expect(path.basename(backup)).toMatch(/^\d+-file\.md$/);
    expect(fs.readFileSync(backup, 'utf8')).toBe('v1');

    await writeFileAtomic(file, 'v2');
    restoreBackup(backup, file);
    expect(readFileIfExists(file)).toBe('v1');
  });

  it('原文件不存在时返回 null', () => {
    expect(backupFile(path.join(root, 'backup', 'missing.md'), 'entry-missing')).toBeNull();
  });

  it('每个 entry 默认只保留最近 5 份', async () => {
    const file = path.join(root, 'backup-prune', 'file.md');
    await writeFileAtomic(file, 'v0');
    for (let index = 1; index <= 6; index += 1) {
      await writeFileAtomic(file, `v${index}`);
      backupFile(file, 'entry-prune');
    }
    const dir = path.join(paths.backupsDir(), 'client-entries', 'entry-prune');
    expect(fs.readdirSync(dir)).toHaveLength(5);

    pruneBackups('entry-prune', 2);
    expect(fs.readdirSync(dir)).toHaveLength(2);
    pruneBackups('entry-prune', 0);
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it('entryId 中的路径分隔符不会逃出备份根', () => {
    const file = path.join(root, 'backup-safe', 'file.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'v1', 'utf8');
    const backup = backupFile(file, '../escape');
    expect(backup).not.toBeNull();
    if (backup === null) throw new Error('expected backup');
    const backupRoot = path.join(paths.backupsDir(), 'client-entries');
    expect(backup.startsWith(backupRoot)).toBe(true);
    expect(path.relative(backupRoot, backup).startsWith('..')).toBe(false);
  });
});

describe('工具函数', () => {
  it('isLockError 只认 EBUSY/EPERM/EACCES（含 cause 链）', () => {
    expect(isLockError(errno('EBUSY'))).toBe(true);
    expect(isLockError(errno('EPERM'))).toBe(true);
    expect(isLockError(errno('EACCES'))).toBe(true);
    expect(isLockError({ cause: { code: 'EBUSY' } })).toBe(true);
    expect(isLockError(errno('ENOENT'))).toBe(false);
    expect(isLockError(errno('EIO'))).toBe(false);
    expect(isLockError(new Error('plain'))).toBe(false);
    expect(isLockError(null)).toBe(false);
    expect(isLockError('EBUSY')).toBe(false);
  });

  it('sha256 输出稳定 hex', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256('中文')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('readFileIfExists 区分不存在与空文件', () => {
    const file = path.join(root, 'read', 'empty.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
    expect(readFileIfExists(file)).toBe('');
    expect(readFileIfExists(path.join(root, 'read', 'missing.md'))).toBeNull();
  });
});
