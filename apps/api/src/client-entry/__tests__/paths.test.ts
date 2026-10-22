import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { assertSafeTarget, isPathInside, resolveWorkspaceDir } from '../paths';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-client-entry-paths-'));
const allowed = path.join(root, 'allowed');
fs.mkdirSync(allowed, { recursive: true });
const isWindows = process.platform === 'win32';

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function catchUnsafe(run: () => void): ApiException {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    return error as ApiException;
  }
  throw new Error('expected CLIENT_ENTRY_PATH_UNSAFE');
}

function expectUnsafeReason(run: () => void, reason: string): void {
  const error = catchUnsafe(run);
  expect(error.code).toBe('CLIENT_ENTRY_PATH_UNSAFE');
  expect(error.context.reason).toBe(reason);
  expect(error.context.path).toBeTypeOf('string');
  expect(error.context.root).toBeTypeOf('string');
}

describe('isPathInside', () => {
  it('自身与后代算 inside，兄弟与父目录算 outside', () => {
    expect(isPathInside(allowed, allowed)).toBe(true);
    expect(isPathInside(path.join(allowed, 'a', 'b'), allowed)).toBe(true);
    expect(isPathInside(path.join(root, 'sibling'), allowed)).toBe(false);
    expect(isPathInside(root, allowed)).toBe(false);
    expect(isPathInside(path.join(allowed, '..foo'), allowed)).toBe(true);
  });
});

describe('assertSafeTarget', () => {
  it('允许不存在的固定子路径（只校验，不创建）', () => {
    const target = path.join(allowed, 'rules', 'jarvis-workbench.md');
    expect(() => assertSafeTarget(target, allowed)).not.toThrow();
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it('允许已存在的普通文件', () => {
    const target = path.join(allowed, 'existing.md');
    fs.writeFileSync(target, 'user content', 'utf8');
    expect(() => assertSafeTarget(target, allowed)).not.toThrow();
  });

  it('拒绝相对路径、NUL、`..` 段与越界', () => {
    expectUnsafeReason(() => assertSafeTarget('rules/a.md', allowed), 'not_absolute');
    expectUnsafeReason(() => assertSafeTarget(path.join(allowed, 'a\0b'), allowed), 'nul');
    expectUnsafeReason(
      () => assertSafeTarget(`${allowed}${path.sep}sub${path.sep}..${path.sep}a.md`, allowed),
      'dotdot_segment',
    );
    expectUnsafeReason(() => assertSafeTarget(path.join(root, 'outside.md'), allowed), 'outside_root');
  });

  it('拒绝目标等于允许根', () => {
    expectUnsafeReason(() => assertSafeTarget(allowed, allowed), 'equals_root');
  });

  it('拒绝 .git 路径段（大小写不敏感）', () => {
    expectUnsafeReason(
      () => assertSafeTarget(path.join(allowed, '.git', 'config'), allowed),
      'git_segment',
    );
    expectUnsafeReason(
      () => assertSafeTarget(path.join(allowed, '.GIT', 'config'), allowed),
      'git_segment',
    );
  });

  it('拒绝已存在的目录', () => {
    const target = path.join(allowed, 'a-directory');
    fs.mkdirSync(target, { recursive: true });
    expectUnsafeReason(() => assertSafeTarget(target, allowed), 'target_directory');
  });

  it('root 不存在时退回词法校验', () => {
    const missingRoot = path.join(root, 'missing-root');
    expect(() =>
      assertSafeTarget(path.join(missingRoot, 'rules', 'a.md'), missingRoot),
    ).not.toThrow();
  });

  it('root 是文件时拒绝', () => {
    const rootFile = path.join(root, 'root-file');
    fs.writeFileSync(rootFile, 'x', 'utf8');
    expectUnsafeReason(
      () => assertSafeTarget(path.join(rootFile, 'a.md'), rootFile),
      'root_not_dir',
    );
  });

  it.skipIf(isWindows)('拒绝目标文件是软链', () => {
    const real = path.join(allowed, 'real.md');
    const link = path.join(allowed, 'link.md');
    fs.writeFileSync(real, 'x', 'utf8');
    fs.symlinkSync(real, link);
    expectUnsafeReason(() => assertSafeTarget(link, allowed), 'target_symlink');
  });

  it.skipIf(isWindows)('拒绝经软链父目录逃出允许根', () => {
    const outside = path.join(root, 'outside-dir');
    fs.mkdirSync(outside, { recursive: true });
    const escape = path.join(allowed, 'escape');
    fs.symlinkSync(outside, escape, 'dir');
    expectUnsafeReason(
      () => assertSafeTarget(path.join(escape, 'a.md'), allowed),
      'realpath_outside',
    );
  });
});

describe('resolveWorkspaceDir', () => {
  it('返回 realpath 后的绝对路径', () => {
    // macOS 的 /var → /private/var 会让 path.resolve 与真实路径不同，统一以 realpath 为准。
    const real = fs.realpathSync(allowed);
    expect(resolveWorkspaceDir(path.relative(process.cwd(), allowed))).toBe(real);
    expect(resolveWorkspaceDir(allowed)).toBe(real);
  });

  it.skipIf(isWindows)('软链 workspace 归一到真实路径', () => {
    const link = path.join(root, 'workspace-link');
    fs.symlinkSync(allowed, link, 'dir');
    expect(resolveWorkspaceDir(link)).toBe(fs.realpathSync(allowed));
  });

  it('不存在或不是目录都拒绝', () => {
    expectUnsafeReason(
      () => resolveWorkspaceDir(path.join(root, 'missing-workspace')),
      'workspace_not_dir',
    );
    const file = path.join(root, 'workspace-file');
    fs.writeFileSync(file, 'x', 'utf8');
    expectUnsafeReason(() => resolveWorkspaceDir(file), 'workspace_not_dir');
  });
});
