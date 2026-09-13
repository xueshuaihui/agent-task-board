import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paths } from '../../common/paths';
import {
  buildArtifactUri,
  deriveArtifactType,
  extensionForType,
  isArtifactType,
  isSafeArtifactUri,
  isSafeIdSegment,
  mimeTypeFor,
  originalExtension,
  resolveArtifactFile,
} from '../artifact-storage';

/**
 * 20.6「路径校验」与 15 章的落地：`artifacts.uri` 是库里的一列文本，没有任何 CHECK 兜底，
 * 所以校验只有这一道。本文件全部围绕「越出产物根目录的 uri 一律读不到字节」来钉。
 */

let dir: string;
let root: string;

/** 产物根目录下一个正常文件：唯一应当被 resolve 成功的路径。 */
function legitUri(): string {
  const uri = buildArtifactUri('T-1', 'R-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'diff');
  const absolute = path.resolve(paths.dataDir(), uri);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, '+ added line\n');
  return uri;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-artifact-path-'));
  process.env.ATB_DATA_DIR = dir;
  root = paths.artifactsDir();
  mkdirSync(root, { recursive: true });
  // 产物根之外的一份机密文件：任何一条 uri 都不许读到它。
  writeFileSync(path.join(dir, 'secret.txt'), 'super secret\n');
  writeFileSync(path.join(dir, 'atb.db-wal-journal'), 'db bytes\n');
});

afterAll(() => {
  delete process.env.ATB_DATA_DIR;
  rmSync(dir, { force: true, recursive: true });
});

describe('isSafeArtifactUri：字符串层的白名单（20.6）', () => {
  it('接受 `artifacts/{task}/{run}/{id}.{ext}` 这一种形状', () => {
    expect(isSafeArtifactUri('artifacts/T-1/R-1/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d.diff')).toBe(true);
  });

  it.each([
    ['绝对路径', '/etc/passwd'],
    ['盘符绝对路径', 'C:\\Windows\\win.ini'],
    ['反斜杠', 'artifacts\\T-1\\x.diff'],
    ['.. 向上穿越', 'artifacts/../../etc/passwd'],
    ['嵌套 .. 穿越', 'artifacts/T-1/../../../secret.txt'],
    ['首段就是 ..', '../atb.db'],
    ['空段（含 //）', 'artifacts//x.diff'],
    ['尾斜杠带来的空段', 'artifacts/T-1/R-1/'],
    ['不以 artifacts 开头', 'secrets/x.txt'],
    ['指向 dataDir 下的库文件', 'atb.db'],
    ['外链当文件路径', 'https://evil.example/x'],
    ['file: 协议', 'file:///etc/passwd'],
    ['空串', ''],
    ['超长（>1024）', `artifacts/${'a'.repeat(1100)}.diff`],
  ])('拒绝%s：%s', (_label, uri) => {
    expect(isSafeArtifactUri(uri)).toBe(false);
  });

  it('拒绝含 NUL 的 uri（截断攻击）', () => {
    expect(isSafeArtifactUri(`artifacts/T-1/R-1/x.diff\0${'a'.repeat(60)}`)).toBe(false);
  });
});

describe('resolveArtifactFile：realpath 之后再比前缀（软链接逃逸）', () => {
  it('产物根目录内的真实文件可以解析', () => {
    const uri = legitUri();
    const absolute = resolveArtifactFile(uri);
    expect(absolute).toBe(path.resolve(paths.dataDir(), uri));
  });

  it('越出产物根目录的 uri 一律返回 null，绝不返回可读路径', () => {
    for (const uri of [
      '/etc/passwd',
      '../secret.txt',
      'artifacts/../../secret.txt',
      'atb.db',
      `${root}/../secret.txt`,
    ]) {
      expect(resolveArtifactFile(uri)).toBeNull();
    }
  });

  it('产物目录里指向外部的软链接读不到（字符串检查会放行，靠 realpath 兜住）', () => {
    const taskDir = path.join(root, 'T-symlink');
    mkdirSync(taskDir, { recursive: true });
    const link = path.join(taskDir, 'escape.diff');
    symlinkSync(path.join(dir, 'secret.txt'), link);
    // 先证明字符串层面它是「合法 uri」，否则这条用例什么也没测。
    const uri = path.relative(paths.dataDir(), link);
    expect(isSafeArtifactUri(uri)).toBe(true);
    expect(resolveArtifactFile(uri)).toBeNull();
  });

  it('产物根目录内部的软链接仍然可用（白名单不该挡死正常预览）', () => {
    const uri = legitUri();
    const absolute = path.resolve(paths.dataDir(), uri);
    const innerDir = path.join(root, 'T-inside');
    mkdirSync(innerDir, { recursive: true });
    const link = path.join(innerDir, 'inner.diff');
    symlinkSync(absolute, link);
    expect(resolveArtifactFile(path.relative(paths.dataDir(), link))).toBe(link);
  });

  it('文件不存在 / 目标是目录时返回 null（上层据此报 missing）', () => {
    expect(resolveArtifactFile('artifacts/T-1/R-1/ffffffff-1111-4111-8111-ffffffffffff.diff')).toBeNull();
    expect(resolveArtifactFile('artifacts/T-1/R-1')).toBeNull();
  });

  it('macOS 的 /var → /private/var 这类根目录自身软链接不算逃逸', () => {
    const uri = legitUri();
    expect(realpathSync(path.resolve(paths.dataDir(), uri)).startsWith(realpathSync(root))).toBe(true);
    expect(resolveArtifactFile(uri)).not.toBeNull();
  });
});

describe('落盘文件名与类型推导（6.10.1 / 20.6 的 ext 白名单）', () => {
  it('id 段只能安全到可以当目录名（任务号里的路径字符在此为止）', () => {
    expect(isSafeIdSegment('T-1001')).toBe(true);
    for (const bad of ['../T-1', 'T-1/../x', '', 'a'.repeat(65), 'T-1 2', 'T-1/2', 'T-1\\2']) {
      expect(isSafeIdSegment(bad)).toBe(false);
    }
  });

  it('Agent 自报的类型不算数：mime 优先、扩展名兜底', () => {
    expect(deriveArtifactType('text/x-diff', 'whatever.bin')).toBe('diff');
    expect(deriveArtifactType('text/plain', 'x.diff')).toBe('text');
    expect(deriveArtifactType('application/octet-stream', 'run.log')).toBe('log');
    expect(deriveArtifactType(undefined, 'shot.png')).toBe('image');
    expect(deriveArtifactType('application/pdf', undefined)).toBe('pdf');
    expect(deriveArtifactType('application/octet-stream', 'mystery')).toBe('file');
  });

  it('SVG 归 file：没有独立源渲染器时不给它执行脚本的机会（15 章）', () => {
    expect(deriveArtifactType('image/svg+xml', 'icon.svg')).toBe('file');
    expect(extensionForType('file', 'icon.svg')).toBe('bin');
  });

  it('ext 白名单：保留可用的原扩展名，其余折到该类型的默认值', () => {
    expect(extensionForType('diff', 'fix.patch')).toBe('patch');
    expect(extensionForType('diff', 'fix.diff')).toBe('diff');
    expect(extensionForType('diff', 'fix.txt')).toBe('diff');
    expect(extensionForType('text', 'data.csv')).toBe('csv');
    expect(extensionForType('text', 'notes.exe')).toBe('txt');
    expect(extensionForType('image', 'photo.jpeg')).toBe('jpeg');
    expect(extensionForType('image', 'photo.svg')).toBe('png');
    expect(extensionForType('markdown', 'x.md')).toBe('md');
    expect(extensionForType('json', 'y.json')).toBe('json');
    expect(extensionForType('link', 'z')).toBe('bin');
  });

  it('originalExtension 不吃路径里的点，也不接受可疑扩展名', () => {
    expect(originalExtension('/tmp/a/b.tar.gz')).toBe('gz');
    expect(originalExtension('.hidden')).toBe('');
    expect(originalExtension('foo.')).toBe('');
    expect(originalExtension('no-ext')).toBe('');
    expect(originalExtension('x.sh;rm -rf')).toBe('');
    expect(originalExtension(undefined)).toBe('');
  });

  it('mime 声明优先并截断到 128 字符、丢掉参数；未知扩展名给 null', () => {
    expect(mimeTypeFor('diff', 'text/plain; charset=utf-8')).toBe('text/plain');
    expect(mimeTypeFor('png', undefined)).toBe('image/png');
    expect(mimeTypeFor('zzz', undefined)).toBeNull();
    expect(mimeTypeFor('txt', `text/plain; x=${'y'.repeat(200)}`)).toBe('text/plain');
    expect(isArtifactType('diff')).toBe(true);
    expect(isArtifactType('exe')).toBe(false);
  });
});
