import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { ApiException } from '../contract/errors';
import { paths } from '../common/paths';

/** settings 的 `artifact_max_mb` 上限是 200（20.9），再多给 1 MB 余量作为 multipart 的硬顶。 */
export const UPLOAD_HARD_CEILING_BYTES = 201 * 1024 * 1024;

/** 半成品目录：断在半路的上传不能混进产物目录，否则被产物侧的读取当文件扫。 */
export const UPLOAD_TMP_DIRNAME = '_upload_tmp';

/** 超过这个年龄的半成品一定是断掉的请求，不能等它自己消失。 */
const STALE_TMP_MS = 6 * 60 * 60 * 1000;

export function uploadTmpDir(): string {
  const dir = path.join(paths.artifactsDir(), UPLOAD_TMP_DIRNAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpFilename(): string {
  return `${Date.now()}-${randomBytes(8).toString('hex')}.part`;
}

/** multer 的 diskStorage：文件边收边落临时盘，不在内存里攒 20 MB。 */
export const uploadStorageOptions: multer.DiskStorageOptions = {
  destination: (_req, _file, cb) => cb(null, uploadTmpDir()),
  filename: (_req, _file, cb) => cb(null, tmpFilename()),
};

export const uploadStorage: multer.StorageEngine = multer.diskStorage(uploadStorageOptions);

/** 单文件产物一次只收一个；超过硬顶由 multer 直接断流，配置的 `artifact_max_mb` 在服务侧再判一次。 */
export const uploadLimits: { files: number; fileSize: number } = {
  files: 1,
  fileSize: UPLOAD_HARD_CEILING_BYTES,
};

export function moveUploadedFile(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
}

/** 清掉断掉的上传。只在上传路径上顺带跑，不注册定时器（定时器归 jobs 侧）。 */
export function sweepStaleUploads(now: number = Date.now()): number {
  const dir = uploadTmpDir();
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.part')) continue;
    const file = path.join(dir, entry);
    try {
      if (now - statSync(file).mtimeMs < STALE_TMP_MS) continue;
      unlinkSync(file);
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

/**
 * busboy 按 latin1 解 `filename`，中文原始名会先花屏再进来。
 * 能干净地转回 UTF‑8 就用转后的，否则保留原样——名字只影响界面显示，不值得为它让上传失败。
 */
export function decodeOriginalName(raw: string | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim().slice(0, 200);
  if (/^[\x20-\x7E]*$/.test(trimmed)) return trimmed;
  try {
    const repaired = Buffer.from(trimmed, 'latin1').toString('utf8');
    if (!repaired.includes('\uFFFD') && repaired.trim() !== '') return repaired.trim();
  } catch {
    /* 保留原样 */
  }
  return trimmed;
}

/** 上传入参的 id 段会直接拼进磁盘路径，先过白名单再谈别的（20.6）。 */
export function assertIdSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.includes('..')) {
    throw new ApiException('VALIDATION_FAILED', `${label} 不合法`, [
      { path: label, code: 'bad_id', message: '只允许字母、数字、点、下划线与短横' },
    ]);
  }
  return value;
}
