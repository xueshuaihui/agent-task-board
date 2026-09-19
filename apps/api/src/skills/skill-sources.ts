import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ApiException } from '../contract/errors';
import { parseFrontmatter } from './skill-markdown';

/**
 * 8.8 技能源：directory 源的本地扫描。git/http 远程源本期只回 501（文案在 service），
 * builtin 源随安装包预置不走文件系统。
 */

/** 一条扫描结果：file 是文件名（不回传绝对路径，避免把本机目录结构整棵吐给前端）。 */
export interface ScannedSkillFile {
  file: string;
  name_guess: string;
  kind: 'atskill' | 'markdown' | 'cursor-rule';
}

const SKILL_FILE_KINDS: Record<string, ScannedSkillFile['kind']> = {
  '.atskill': 'atskill',
  '.md': 'markdown',
  '.mdc': 'cursor-rule',
};

/**
 * 目录扫描（node:fs，只看目录直接子项，不递归）。路径校验防穿越：
 * 必须是绝对路径、不含 `..` 段、resolve 后仍是自身（拒绝符号链接式的绕路写法没有意义，
 * 目录源本来就是用户本机路径，这里防的是相对路径/越界写法，不是沙箱）。
 */
export function scanDirectory(rawPath: string): ScannedSkillFile[] {
  if (!rawPath || !path.isAbsolute(rawPath)) {
    throw new ApiException('VALIDATION_FAILED', '目录源路径必须是绝对路径', [
      { path: 'path', code: 'invalid_path', message: rawPath || '（空）' },
    ]);
  }
  if (rawPath.split(/[\\/]/).includes('..')) {
    throw new ApiException('VALIDATION_FAILED', '目录源路径不允许包含 ..', [
      { path: 'path', code: 'path_traversal', message: rawPath },
    ]);
  }
  const resolved = path.resolve(rawPath);
  if (resolved !== rawPath && resolved !== path.normalize(rawPath)) {
    throw new ApiException('VALIDATION_FAILED', '目录源路径不合法', [
      { path: 'path', code: 'invalid_path', message: rawPath },
    ]);
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ApiException('VALIDATION_FAILED', '目录源路径不存在或不是目录', [
      { path: 'path', code: 'not_a_directory', message: resolved },
    ]);
  }

  const items: ScannedSkillFile[] = [];
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const kind = SKILL_FILE_KINDS[path.extname(entry.name).toLowerCase()];
    if (!kind) continue;
    items.push({ file: entry.name, name_guess: guessName(resolved, entry.name, kind), kind });
  }
  items.sort((a, b) => a.file.localeCompare(b.file));
  return items;
}

function guessName(dir: string, file: string, kind: ScannedSkillFile['kind']): string {
  const fallback = file.replace(/\.(atskill|md|markdown|mdc)$/i, '');
  try {
    const raw = readFileSync(path.join(dir, file), 'utf8');
    if (kind === 'atskill') {
      const parsed: unknown = JSON.parse(raw);
      const name = (parsed as { name?: unknown })?.name;
      return typeof name === 'string' && name.trim() ? name.trim() : fallback;
    }
    // .md / .mdc：frontmatter 的 name 字段优先（.mdc 的 Cursor 元数据头同构）。
    const { frontmatter } = parseFrontmatter(raw);
    const name = frontmatter?.name?.trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}
