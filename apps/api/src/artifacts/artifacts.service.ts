import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Artifact } from '@prisma/client';
import type { ArtifactType } from '../contract/enums';
import { ApiException } from '../contract/errors';
import { ARTIFACT_RUN_TOTAL_MAX_BYTES } from '../contract/settings';
import { newId } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { paths } from '../common/paths';
import { AppLogger } from '../infra/logger';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { parseUnifiedDiff, type DiffResult } from './artifact-diff';
import {
  PREVIEWABLE_TYPES,
  buildArtifactUri,
  deriveArtifactType,
  extensionForType,
  isSafeIdSegment,
  mimeTypeFor,
  originalExtension,
  resolveArtifactFile,
} from './artifact-storage';
import { ArtifactSignService, type SignedKind } from './artifact-sign.service';
import { assertIdSegment, decodeOriginalName, moveUploadedFile, sweepStaleUploads } from './artifact-upload';
import type { ArtifactUploadInput } from './artifact.dto';

/** 产物行就是 Prisma 映射出来的 `artifacts`，读写两侧共用同一个形状，不再手工声明列名。 */
type ArtifactRecord = Artifact;

export interface UploadResult {
  id: string;
  uri: string;
  type: ArtifactType;
  name: string;
  size_bytes: number;
  mime_type: string | null;
  /** 6.10.1：自报类型与推导不一致时以推导为准，同时把两边都回显出来。 */
  requested_type: string | null;
  type_matched: boolean;
}

export interface ArtifactPreview {
  enabled: boolean;
  kind: 'diff' | 'text' | 'image' | 'link' | 'none';
  reason: string | null;
}

export interface ArtifactMetaDto {
  id: string;
  task_id: string;
  run_id: string;
  type: ArtifactType;
  name: string;
  uri: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string | null;
  /** 13 章：行在、磁盘文件不在（备份只含 SQLite，恢复后必然出现）。 */
  missing: boolean;
  preview: ArtifactPreview;
  /** 元信息接口顺带给一次性 URL，前端不必为每个资源再发一次 sign（13 章「资源型端点例外」）。 */
  signed_url: string | null;
}

@Injectable()
export class ArtifactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly sign: ArtifactSignService,
    private readonly logger: AppLogger,
  ) {}

  // ---------------------------------------------------------------- 上传（Agent）

  async upload(
    input: ArtifactUploadInput,
    file: { path?: string; originalname?: string; mimetype?: string; size: number } | undefined,
  ): Promise<UploadResult> {
    sweepStaleUploads();
    const taskId = assertIdSegment(input.task_id, 'task_id');
    const runId = assertIdSegment(input.run_id, 'run_id');
    if (!file?.path) {
      throw new ApiException('VALIDATION_FAILED', '缺少 file 字段（multipart 单文件）', [
        { path: 'file', code: 'missing_file', message: '需要一个二进制文件' },
      ]);
    }

    const run = await this.prisma.taskRun.findUnique({
      where: { id: runId },
      select: { id: true, taskId: true },
    });
    if (!run || run.taskId !== taskId) {
      this.discard(file.path);
      throw new ApiException('NOT_FOUND', `执行记录 ${runId} 不存在或不属于任务 ${taskId}`);
    }

    const maxBytes = (await this.settings.get('artifact_max_mb')) * 1024 * 1024;
    if (file.size > maxBytes) {
      this.discard(file.path);
      throw new ApiException(
        'ARTIFACT_TOO_LARGE',
        `单文件超过上限 ${Math.round(maxBytes / 1024 / 1024)} MB`,
        { size_bytes: file.size, limit_bytes: maxBytes },
      );
    }
    try {
      await this.assertRunBudget(runId, file.size);
    } catch (error) {
      // 与其余拒绝路径一致：被拒的字节不能留在 _upload_tmp 里等 6 小时。
      this.discard(file.path);
      throw error;
    }

    const originalName = decodeOriginalName(file.originalname);
    const declaredMime = input.mime_type || file.mimetype || '';
    const type = deriveArtifactType(declaredMime, originalName);
    if (type === 'link') {
      this.discard(file.path);
      throw new ApiException('VALIDATION_FAILED', 'link 类型不占磁盘，不要走上传接口', [
        { path: 'type', code: 'link_not_uploadable', message: 'link 由 complete_task 直接插入' },
      ]);
    }

    const id = newId();
    const ext = extensionForType(type, originalName);
    const uri = buildArtifactUri(taskId, runId, id, ext);
    const absolute = path.resolve(paths.dataDir(), uri);
    try {
      moveUploadedFile(file.path, absolute);
      const name = (input.name?.trim() || originalName || '').slice(0, 200);
      const storedMime = mimeTypeFor(originalExtension(absolute) || ext, declaredMime || undefined);
      await this.prisma.artifact.create({
        data: {
          id,
          runId,
          taskId,
          type,
          uri,
          sizeBytes: file.size,
          mimeType: storedMime,
          // 20.7：name 不是列，只能落在 metadata；缺省时不写，读取侧从 uri 末段推导。
          metadata: JSON.stringify(name === '' ? {} : { name }),
          createdAt: nowSql(),
        },
      });
      return {
        id,
        uri,
        type,
        name: name || uri.split('/').pop()!,
        size_bytes: file.size,
        mime_type: storedMime,
        requested_type: input.type ?? null,
        type_matched: input.type === undefined || input.type === type,
      };
    } catch (error) {
      this.discard(absolute);
      throw error;
    }
  }

  /** 20.6：单 Run 累计 ≤ 200 MB，超出后该 Run 的后续上传被拒并写 warn 日志。 */
  private async assertRunBudget(runId: string, incoming: number): Promise<void> {
    const rows = await this.prisma.artifact.findMany({
      where: { runId },
      select: { sizeBytes: true },
    });
    const used = rows.reduce((total, row) => total + (row.sizeBytes ?? 0), 0);
    if (used + incoming <= ARTIFACT_RUN_TOTAL_MAX_BYTES) return;
    this.logger.warn(
      `Run ${runId} 产物累计 ${used + incoming} B 超过 200 MB，拒绝本次上传`,
      'artifacts',
    );
    throw new ApiException('ARTIFACT_TOO_LARGE', '该 Run 的产物累计已超过 200 MB', {
      used_bytes: used,
      incoming_bytes: incoming,
      limit_bytes: ARTIFACT_RUN_TOTAL_MAX_BYTES,
    });
  }

  private discard(absolute: string): void {
    try {
      if (existsSync(absolute)) unlinkSync(absolute);
    } catch {
      /* 临时文件清不掉只占磁盘，不影响这次请求的结论 */
    }
  }

  // ---------------------------------------------------------------- 元信息（UI）

  async meta(id: string): Promise<ArtifactMetaDto> {
    const row = await this.resolveRow(id);
    const absolute = row.type === 'link' ? null : resolveArtifactFile(row.uri);
    const missing = row.type !== 'link' && absolute === null;
    const onDiskSize = absolute ? statSync(absolute).size : null;
    const preview = await this.previewFor(row, missing);
    return {
      id: row.id,
      task_id: row.taskId,
      run_id: row.runId,
      type: row.type as ArtifactType,
      name: displayName(row),
      uri: row.uri,
      size_bytes: onDiskSize ?? row.sizeBytes,
      mime_type: row.mimeType,
      created_at: toIso(row.createdAt),
      missing,
      preview,
      signed_url: absolute ? this.sign.sign(row.id, 'raw').url : null,
    };
  }

  private async previewFor(row: ArtifactRecord, missing: boolean): Promise<ArtifactPreview> {
    const type = row.type as ArtifactType;
    if (type === 'link') return { enabled: true, kind: 'link', reason: null };
    if (missing) {
      return { enabled: false, kind: 'none', reason: 'file_missing' };
    }
    // 6.10.1 第一列就是 artifacts.type 枚举；阶段二的四类在这里统一降成「只下载」。
    if (!PREVIEWABLE_TYPES.includes(type)) {
      return { enabled: false, kind: 'none', reason: 'renderer_not_in_stage1' };
    }
    const maxBytes = (await this.settings.get('artifact_max_mb')) * 1024 * 1024;
    // 6.10.3：超过上限的产物只提供下载，不做内嵌预览。
    if ((row.sizeBytes ?? 0) > maxBytes) {
      return { enabled: false, kind: 'none', reason: 'too_large' };
    }
    const kind = type === 'diff' ? 'diff' : type === 'image' ? 'image' : 'text';
    return { enabled: true, kind, reason: null };
  }

  signUrl(id: string, kind: SignedKind): { url: string; expires_at: string; ttl_seconds: number } {
    return this.sign.sign(id, kind);
  }

  // ---------------------------------------------------------------- 资源读取（签名或 Authorization）

  /** 缩略图当前是原图透传，见 `writeTo` 里的说明。 */
  async writeTo(id: string, kind: SignedKind, res: Response): Promise<void> {
    const row = await this.resolveRow(id);
    if (kind === 'thumbnail' && row.type !== 'image') {
      throw new ApiException('NOT_FOUND', '该产物不是图片，没有缩略图');
    }
    const absolute = this.requireFile(row);
    const stats = statSync(absolute);
    const ext = originalExtension(absolute);
    const name = displayName(row);

    res.setHeader('Content-Type', row.mimeType || mimeTypeFor(ext, undefined) || 'application/octet-stream');
    res.setHeader('Content-Length', String(stats.size));
    // 15 章硬约束 3：nosniff + Content-Disposition，Agent 上传的内容不能被当脚本执行。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(row.type === 'image' && kind === 'raw' ? 'inline' : 'attachment', name),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Atb-Artifact-Type', row.type);
    if (kind === 'thumbnail') {
      // TODO(阶段二)：真正的缩放需要解码位图，纯 Node 做不到，先透传原图（见交付报告）。
      res.setHeader('X-Atb-Thumbnail', 'passthrough');
    }
    await pipeline(createReadStream(absolute), res);
  }

  private requireFile(row: ArtifactRecord): string {
    if (row.type === 'link') {
      throw new ApiException('NOT_FOUND', 'link 类型产物没有本地文件，请直接打开 uri', {
        artifact_id: row.id,
      });
    }
    const absolute = resolveArtifactFile(row.uri);
    if (!absolute) {
      throw new ApiException('ARTIFACT_LOST', '产物文件已丢失（不在备份范围内）', undefined, {
        artifact_id: row.id,
        uri: row.uri,
      });
    }
    return absolute;
  }

  // ---------------------------------------------------------------- diff

  async diff(id: string): Promise<DiffResult & { truncated: boolean; name: string }> {
    const row = await this.resolveRow(id);
    if (!['diff', 'text', 'log', 'file'].includes(row.type)) {
      throw new ApiException('VALIDATION_FAILED', `「${row.type}」类型不是文本，无法解析为 diff`, undefined, {
        artifact_id: row.id,
      });
    }
    const absolute = this.requireFile(row);
    const maxBytes = (await this.settings.get('artifact_max_mb')) * 1024 * 1024;
    const stats = statSync(absolute);
    const handle = readFileSync(absolute);
    const truncated = stats.size > maxBytes;
    const text = truncated ? handle.subarray(0, maxBytes).toString('utf8') : handle.toString('utf8');
    return { ...parseUnifiedDiff(text), truncated, name: displayName(row) };
  }

  // ---------------------------------------------------------------- 级联清理

  /**
   * 4.3.1 规则 4 / 验收 38：任务删除后要把 `{产物根}/{task_id}/` 整个目录带走。
   * 按目录删而不是按 uri 删——库里没有的行（写失败的残留）也要被清掉。
   */
  cleanupTaskDir(taskId: string): { removed: boolean } {
    if (!isSafeIdSegment(taskId)) {
      throw new ApiException('VALIDATION_FAILED', 'task_id 不能用作目录名');
    }
    const target = path.join(paths.artifactsDir(), taskId);
    const existed = existsSync(target);
    if (existed) rmSync(target, { recursive: true, force: true });
    return { removed: existed };
  }

  /** 给备份侧与测试用：产物根目录是否存在（备份不含它，恢复后要靠这个提示用户）。 */
  artifactsRoot(): string {
    const dir = paths.artifactsDir();
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async resolveRow(id: string): Promise<ArtifactRecord> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new ApiException('NOT_FOUND', '产物不存在');
    }
    const row = await this.prisma.artifact.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', '产物不存在');
    return row as unknown as ArtifactRecord;
  }
}

/** 20.7：`name` 不是列，metadata.name 优先，否则 uri 末段；link 没有文件名就显示 host。 */
function displayName(row: ArtifactRecord): string {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }
  const named = metadata.name;
  if (typeof named === 'string' && named.trim() !== '') return named.trim();
  if (row.type === 'link') {
    try {
      return new URL(row.uri).host;
    } catch {
      return row.uri;
    }
  }
  return row.uri.split('/').filter(Boolean).pop() ?? row.uri;
}

/** 文件名可能是中文，ASCII 那份只作兜底，真正的名字走 RFC 5987 的 `filename*`。 */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name
    .replace(/[\\":\r\n]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .slice(0, 120);
  return `${kind}; filename="${ascii || 'artifact'}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
