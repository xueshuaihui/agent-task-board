import fs from 'node:fs';
import path from 'node:path';
import { ApiException } from '../contract/errors';

/**
 * 客户端入口只会写 adapter 产出的固定子路径，但路径最终来自用户选择的 workspace
 * 与 home 覆盖，仍必须在这里做一次「写盘前」的独立校验：installer 不应假设调用方
 * 已经检查过绝对路径、软链与越界。
 */

function errnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

function unsafe(targetPath: string, allowedRoot: string, reason: string): never {
  throw new ApiException(
    'CLIENT_ENTRY_PATH_UNSAFE',
    `客户端入口目标路径不安全：${targetPath}`,
    undefined,
    { path: targetPath, root: allowedRoot, reason },
  );
}

/** `rel === ''` 视为 inside；`..` 或绝对路径（Windows 跨盘符）视为 outside。 */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

/**
 * 写盘前的路径闸。只做校验，不创建目录、不写文件——预览阶段也会调用它，
 * 因此任何副作用都会让「预览不落盘」的承诺失效。
 *
 * 校验顺序有意从便宜到昂贵：词法检查 → 目标自身 lstat → 最近存在祖先的 realpath。
 * 最后一步是唯一能发现「父目录是指向外部的软链」的手段；root 不存在时没有可解析的
 * realpath，退回纯词法判断（此时也不可能有指向外部的中间软链）。
 */
export function assertSafeTarget(targetPath: string, allowedRoot: string): void {
  if (!targetPath || !allowedRoot || targetPath.includes('\0') || allowedRoot.includes('\0')) {
    unsafe(targetPath, allowedRoot, 'nul');
  }
  if (!path.isAbsolute(targetPath)) unsafe(targetPath, allowedRoot, 'not_absolute');
  if (!path.isAbsolute(allowedRoot)) unsafe(targetPath, allowedRoot, 'root_not_absolute');

  if (process.platform === 'win32') {
    // ADS（`file.txt:stream`）在资源管理器里不可见，写入后会变成另一份内容。
    const driveRoot = path.parse(targetPath).root;
    if (targetPath.slice(driveRoot.length).includes(':')) unsafe(targetPath, allowedRoot, 'ads');
  }

  // adapter 拼出的路径不含 `..`；用户输入里出现即视为绕过尝试，不做「规范化后再放行」。
  const rawSegments =
    process.platform === 'win32' ? targetPath.split(/[\\/]+/) : targetPath.split(path.sep);
  if (rawSegments.includes('..')) unsafe(targetPath, allowedRoot, 'dotdot_segment');

  const normalizedTarget = path.resolve(targetPath);
  const segments = normalizedTarget.split(path.sep);
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    unsafe(targetPath, allowedRoot, 'git_segment');
  }

  const rel = path.relative(allowedRoot, targetPath);
  if (rel === '') unsafe(targetPath, allowedRoot, 'equals_root');
  if (!isPathInside(targetPath, allowedRoot)) unsafe(targetPath, allowedRoot, 'outside_root');

  // 先确认允许根本身可用：root 是文件时，目标的 lstat 会先报 ENOTDIR，
  // 但真正的原因（调用方给错了根）用 root_not_dir 更清楚。
  let rootReal: string | undefined;
  try {
    const rootStat = fs.statSync(allowedRoot);
    if (!rootStat.isDirectory()) unsafe(targetPath, allowedRoot, 'root_not_dir');
    rootReal = fs.realpathSync(allowedRoot);
  } catch (error) {
    if (error instanceof ApiException) throw error;
    const code = errnoCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') unsafe(targetPath, allowedRoot, 'root_realpath_failed');
  }

  let targetStat: fs.Stats | undefined;
  try {
    targetStat = fs.lstatSync(targetPath);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') unsafe(targetPath, allowedRoot, 'stat_failed');
  }
  if (targetStat) {
    if (targetStat.isSymbolicLink()) unsafe(targetPath, allowedRoot, 'target_symlink');
    if (targetStat.isDirectory()) unsafe(targetPath, allowedRoot, 'target_directory');
    if (!targetStat.isFile()) unsafe(targetPath, allowedRoot, 'target_not_file');
  }

  // root 不存在时没有可解析的 realpath，词法检查通过即可。
  if (rootReal === undefined) return;

  let probe = targetPath;
  for (;;) {
    let real: string | undefined;
    try {
      real = fs.realpathSync(probe);
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unsafe(targetPath, allowedRoot, 'realpath_failed');
    }
    if (real !== undefined) {
      if (!isPathInside(real, rootReal)) unsafe(targetPath, allowedRoot, 'realpath_outside');
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe) unsafe(targetPath, allowedRoot, 'no_existing_ancestor');
    probe = parent;
  }
}

/**
 * 用户选择的 workspace 必须是现存目录；返回 realpath 后的绝对路径。
 * 软链工作区归一到真实路径，避免同一物理文件因入口路径不同生出两条台账。
 */
export function resolveWorkspaceDir(input: string): string {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    unsafe(input, input, 'workspace_not_dir');
  }
  const resolved = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    unsafe(resolved, resolved, 'workspace_not_dir');
  }
  if (!stat.isDirectory()) unsafe(resolved, resolved, 'workspace_not_dir');
  try {
    return fs.realpathSync(resolved);
  } catch {
    // 目录刚被删或权限变化：与「不是目录」一样拒绝，避免带着不可解析的根继续写盘。
    unsafe(resolved, resolved, 'workspace_not_dir');
  }
}

/**
 * custom 伪客户端的安装根：与 resolveWorkspaceDir 的差异是允许目标目录尚不存在
 * （例如客户端的 `<workspace>/.codebuddy/rules` 要等首次安装才创建）。
 *
 * 返回值是「最近存在祖先的 realpath + 缺失尾巴」：目录已存在时即 realpath，
 * 尚不存在时把所选目录接到祖先 realpath 上（macOS /var → /private/var 也同基）。
 * 台账 workspace_path 记它、assertSafeTarget 拿它当允许根。
 * 校验顺序：目标到最近存在祖先这一段出现软链即拒绝（否则软链会把安装点悄悄换到别处，
 * 台账里的目录与真实落点分叉）；已存在部分由 realpath 归一，台账不因入口写法分叉。
 * 最近存在祖先必须目录且 realpath 可解析，其余 IO 异常沿用 unsafe 报错风格。
 */
export function resolveInstallRoot(input: string): string {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    unsafe(input, input, 'install_root_not_dir');
  }
  const resolved = path.resolve(input);
  let probe = resolved;
  for (;;) {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(probe);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') unsafe(resolved, resolved, 'install_root_stat_failed');
    }
    if (stat !== undefined) {
      if (stat.isSymbolicLink()) unsafe(resolved, resolved, 'install_root_symlink');
      if (!stat.isDirectory()) unsafe(resolved, resolved, 'install_root_not_dir');
      let real: string;
      try {
        real = fs.realpathSync(probe);
      } catch {
        // 目录刚被删或权限变化：与「不是目录」一样拒绝，不带着不可解析的根继续。
        unsafe(resolved, resolved, 'install_root_not_dir');
      }
      // 缺失尾巴接到祖先 realpath 上（macOS /var → /private/var 也成立）：返回值与
      // 后续 assertSafeTarget 的词法/realpath 两条检查同基，台账不因入口写法分叉。
      const tail = path.relative(probe, resolved);
      return tail === '' ? real : path.join(real, tail);
    }
    const parent = path.dirname(probe);
    if (parent === probe) unsafe(resolved, resolved, 'install_root_no_ancestor');
    probe = parent;
  }
}
