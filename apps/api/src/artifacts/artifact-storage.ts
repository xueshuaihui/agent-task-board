import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_TYPES, type ArtifactType } from '../contract/enums';
import { paths } from '../common/paths';

/** 阶段一有渲染器的类型（17.2）：其余类型一律只给下载，不做预览按钮。 */
export const PREVIEWABLE_TYPES: ArtifactType[] = ['diff', 'text', 'log', 'image'];

/** `link` 不占磁盘，走另一条校验（20.6）。 */
export const LINK_SCHEME_RE = /^https?:\/\//i;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
const TEXT_EXTS = ['txt', 'log', 'csv', 'tsv', 'ini', 'conf', 'env', 'hosts'] as const;

const MIME_BY_EXT: Record<string, string> = {
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function originalExtension(name: string | undefined | null): string {
  if (!name) return '';
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

/**
 * 6.10.1：类型由服务端按 `mime_type` + 扩展名推导，Agent 自报的类型不作为依据。
 * 先看 mime（上传接口的声明更可靠），再看扩展名兜底，最后归 `file`。
 */
export function deriveArtifactType(mimeType: string | undefined, filename: string | undefined): ArtifactType {
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  const ext = originalExtension(filename);

  if (mime === 'text/x-diff' || mime === 'application/diff' || mime === 'text/x-patch') return 'diff';
  // SVG 是脚本可执行的 XML，`/raw` 被当文档打开时会在本机源上跑脚本，阶段一没有独立源渲染器（15 章）。
  if (mime === 'image/svg+xml') return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/json' || mime === 'text/json') return 'json';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/plain') return 'text';

  if (ext === 'diff' || ext === 'patch') return 'diff';
  if ((IMAGE_EXTS as readonly string[]).includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'json') return 'json';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md') return 'markdown';
  if (ext === 'log') return 'log';
  if ((TEXT_EXTS as readonly string[]).includes(ext)) return 'text';
  if (mime.startsWith('text/')) return 'text';
  return 'file';
}

/**
 * 20.6 的 ext 白名单：落盘文件名不接受 Agent 给的原始名，只接受该类型允许的几个扩展名，
 * 保留原扩展名是为了让「下载」后的文件名仍然可用（`foo.patch` 不该变成 `foo.diff`）。
 */
export function extensionForType(type: ArtifactType, filename: string | undefined): string {
  const ext = originalExtension(filename);
  switch (type) {
    case 'diff':
      return ext === 'patch' ? 'patch' : 'diff';
    case 'image':
      return (IMAGE_EXTS as readonly string[]).includes(ext) ? ext : 'png';
    case 'text':
      return ext === 'csv' || ext === 'tsv' || ext === 'log' ? ext : 'txt';
    case 'log':
      return 'log';
    case 'markdown':
      return 'md';
    case 'json':
      return 'json';
    case 'html':
      return 'html';
    case 'pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

export function mimeTypeFor(ext: string, declared: string | undefined): string | null {
  if (declared) return declared.split(';')[0].trim().slice(0, 128);
  return MIME_BY_EXT[ext] ?? null;
}

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** 20.6 路径校验：相对、正斜杠、无 `..` 段、不越出产物根目录。 */
export function isSafeArtifactUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 1024) return false;
  if (uri.startsWith('/') || uri.startsWith('\\')) return false;
  if (uri.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(uri)) return false;
  if (uri.includes('\0')) return false;
  const segments = uri.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return false;
  return segments[0] === 'artifacts';
}

/**
 * uri → 绝对路径。除了字符串层面的白名单，还 realpath 一次再比前缀：
 * 产物目录里被人放了一个指向 `/etc` 的软链接时，字符串检查是放行不了的。
 */
export function resolveArtifactFile(uri: string): string | null {
  if (!isSafeArtifactUri(uri)) return null;
  const root = paths.artifactsDir();
  const absolute = path.resolve(paths.dataDir(), uri);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  if (!existsSync(absolute)) return null;
  try {
    const real = realpathSync(absolute);
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    if (!real.startsWith(realRoot + path.sep)) return null;
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return absolute;
}

export function artifactFileSize(absolute: string): number | null {
  try {
    const stats = lstatSync(absolute);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

/** 相对路径以 `artifacts/` 开头，是因为 tasks 侧删除时按数据目录解析（见其 deleteArtifactFiles）。 */
export function buildArtifactUri(taskId: string, runId: string, artifactId: string, ext: string): string {
  return `artifacts/${taskId}/${runId}/${artifactId}.${ext}`;
}

/** 目录名从 id 派生，所以任务号里的路径字符必须先到此为止。 */
export function isSafeIdSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) && !value.includes('..');
}
