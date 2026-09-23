import { Writable } from 'node:stream';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@prisma/client';
import { ARTIFACT_RUN_TOTAL_MAX_BYTES } from '../../contract/settings';
import { ApiException } from '../../contract/errors';
import { newId } from '../../contract/ids';
import { nowSql } from '../../contract/time';
import { paths } from '../../common/paths';
import { applyMigrations } from '../../infra/bootstrap';
import type { AppLogger } from '../../infra/logger';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import type { SignedKind } from '../artifact-sign.service';
import { ArtifactSignService } from '../artifact-sign.service';
import { uploadTmpDir } from '../artifact-upload';
import { ArtifactsService } from '../artifacts.service';

/**
 * 6.10 / 13 章产物侧的服务层用例：上传落盘、元信息、预览开关、`/raw` 响应头、
 * `missing` 与 `ARTIFACT_LOST` 的分工（13 章最后一句）。
 * 全部直调 service，不起监听进程。
 */

let dir: string;
let prisma: PrismaService;
let settings: SettingsService;
let sign: ArtifactSignService;
let artifacts: ArtifactsService;
let logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

const UI_TOKEN = `ui-${'feedface'.repeat(8)}`;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-artifacts-'));
  process.env.ATB_DATA_DIR = dir;
  process.env.ATB_UI_TOKEN = UI_TOKEN;
  applyMigrations();
  prisma = new PrismaService();
  settings = new SettingsService(prisma);
  sign = new ArtifactSignService();
  logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  artifacts = new ArtifactsService(prisma, settings, sign, logger as unknown as AppLogger);
});

afterEach(async () => {
  await settings.patch({ artifact_max_mb: 20 });
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  delete process.env.ATB_UI_TOKEN;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

beforeEach(async () => {
  await prisma.artifact.deleteMany();
  await prisma.taskRun.deleteMany();
  await prisma.task.deleteMany();
  rmSync(paths.artifactsDir(), { force: true, recursive: true });
  mkdirSync(paths.artifactsDir(), { recursive: true });
  logger.warn.mockClear();
});

/** 造任务 + 一条 Run：产物行的两个外键都指向它。B8s 后上传只认当前 run，任务要挂上 currentRunId。 */
async function seedRun(taskId = 'T-1', runId = 'R-1'): Promise<{ taskId: string; runId: string }> {
  await prisma.task.create({
    data: { id: taskId, title: `${taskId} 标题`, status: 'RUNNING', currentRunId: runId },
  });
  await prisma.taskRun.create({
    data: { id: runId, taskId, runNumber: 1, status: 'RUNNING', triggerType: 'agent_poll' },
  });
  return { taskId, runId };
}

/** 直接插一行产物（绕过上传接口），用来造脏 uri / link / 缺失文件等状态。 */
async function insertArtifact(
  overrides: Partial<Artifact> & { uri: string; type: string },
): Promise<Artifact> {
  const row: Artifact = {
    id: overrides.id ?? newId(),
    runId: overrides.runId ?? 'R-1',
    taskId: overrides.taskId ?? 'T-1',
    type: overrides.type,
    uri: overrides.uri,
    sizeBytes: 'sizeBytes' in overrides ? (overrides.sizeBytes ?? null) : 12,
    mimeType: overrides.mimeType ?? null,
    metadata: overrides.metadata ?? '{}',
    createdAt: overrides.createdAt ?? nowSql(),
  };
  await prisma.artifact.create({ data: row });
  return row;
}

/** 写一个 multer 的半成品，返回上传接口要的那个 file 形状。 */
function stagedFile(bytes: Buffer, originalname: string): {
  file: { path: string; originalname: string; mimetype: string; size: number };
  absolute: string;
} {
  const absolute = path.join(uploadTmpDir(), `${Date.now()}-${newId()}.part`);
  writeFileSync(absolute, bytes);
  return {
    absolute,
    file: { path: absolute, originalname, mimetype: 'application/octet-stream', size: bytes.length },
  };
}

function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(`http://127.0.0.1${url}`).searchParams);
}

/** 替 express 收响应头与流式 body。 */
function mockRes(): { res: Response; headers: Map<string, string>; body: () => Buffer } {
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  Object.assign(stream, {
    setHeader(name: string, value: string | number) {
      headers.set(String(name).toLowerCase(), String(value));
    },
    getHeader(name: string) {
      return headers.get(String(name).toLowerCase());
    },
  });
  return { res: stream as unknown as Response, headers, body: () => Buffer.concat(chunks) };
}

async function thrown(call: () => unknown | Promise<unknown>): Promise<ApiException> {
  try {
    await call();
  } catch (error) {
    return error as ApiException;
  }
  throw new Error('用例期望抛错');
}

describe('上传（POST /artifacts，Agent 凭证）', () => {
  it('落库 + 落盘：路径是 artifacts/{task}/{run}/{id}.{ext}，uri 是相对路径', async () => {
    const { taskId, runId } = await seedRun();
    const { file, absolute } = stagedFile(Buffer.from('--- a/x\n+++ b/x\n+1\n'), 'patch-1.diff');
    file.mimetype = 'text/x-diff';

    const result = await artifacts.upload({ task_id: taskId, run_id: runId, type: 'diff' }, file);

    expect(result.uri).toBe(`artifacts/${taskId}/${runId}/${result.id}.diff`);
    expect(result.type).toBe('diff');
    expect(result.size_bytes).toBe(19);
    expect(result.mime_type).toBe('text/x-diff');
    expect(result.type_matched).toBe(true);
    expect(existsSync(absolute)).toBe(false);
    const stored = path.resolve(paths.dataDir(), result.uri);
    expect(readFileSync(stored, 'utf8')).toContain('+1');

    const row = await prisma.artifact.findUnique({ where: { id: result.id } });
    expect(row?.taskId).toBe(taskId);
    expect(row?.runId).toBe(runId);
    expect(JSON.parse(row?.metadata ?? '{}')).toEqual({ name: 'patch-1.diff' });
  });

  it('Agent 自报类型与推导不一致时以推导为准，两边都回显（6.10.1）', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('plain'), 'notes.txt');
    file.mimetype = 'text/plain';

    const result = await artifacts.upload({ task_id: taskId, run_id: runId, type: 'image' }, file);
    expect(result.type).toBe('text');
    expect(result.requested_type).toBe('image');
    expect(result.type_matched).toBe(false);
    expect(result.uri.endsWith('.txt')).toBe(true);
  });

  it('中文原始名复原后只作显示名，落盘文件名不含它（20.6 / 20.7）', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('内容'), Buffer.from('构建日志.txt', 'utf8').toString('latin1'));
    file.mimetype = 'text/plain';

    const result = await artifacts.upload({ task_id: taskId, run_id: runId, name: 'CI 构建日志' }, file);
    expect(result.name).toBe('CI 构建日志');
    expect(result.uri).not.toContain('构建');
    expect((await artifacts.meta(result.id)).name).toBe('CI 构建日志');
  });

  it('link 行不由上传接口产生：自报 link 也只按推导落库（20.6 写入顺序）', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('x'), 'a.bin');
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId, type: 'link' }, file);

    expect(uploaded.type).toBe('file');
    expect(uploaded.requested_type).toBe('link');
    expect(uploaded.type_matched).toBe(false);
    const row = await prisma.artifact.findUnique({ where: { id: uploaded.id } });
    expect(row?.type).toBe('file');
    expect((await prisma.artifact.count({ where: { type: 'link' } }))).toBe(0);
  });

  it('run 不存在或不属于该任务 → NOT_FOUND，且不留下上传的字节', async () => {
    const { taskId } = await seedRun('T-1', 'R-1');
    const { file, absolute } = stagedFile(Buffer.from('x'), 'a.diff');
    const error = await thrown(() =>
      artifacts.upload({ task_id: taskId, run_id: 'R-404', mime_type: 'text/x-diff' }, file),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(existsSync(absolute)).toBe(false);
    expect(await prisma.artifact.count()).toBe(0);
  });

  it('B8s：非当前执行的 run_id 上传 → 409 TASK_NOT_RUNNING，字节不落盘（回收后重领不再静默挂旧 run）', async () => {
    const { taskId, runId } = await seedRun('T-1', 'R-1');
    // 模拟租约回收后重领：旧 run 置 ABANDONED（同任务至多一条 RUNNING），currentRunId 指向新 run。
    await prisma.taskRun.update({ where: { id: runId }, data: { status: 'ABANDONED' } });
    await prisma.taskRun.create({
      data: { id: 'R-2', taskId, runNumber: 2, status: 'RUNNING', triggerType: 'agent_poll' },
    });
    await prisma.task.update({ where: { id: taskId }, data: { currentRunId: 'R-2' } });
    const { file, absolute } = stagedFile(Buffer.from('x'), 'late.txt');
    const error = await thrown(() => artifacts.upload({ task_id: taskId, run_id: runId }, file));
    expect(error.code).toBe('TASK_NOT_RUNNING');
    expect(error.status).toBe(409);
    expect(existsSync(absolute)).toBe(false);
    expect(await prisma.artifact.count()).toBe(0);
  });

  it('task_id / run_id 里的路径字符在拼路径之前就被拒（20.6）', async () => {
    await seedRun();
    for (const bad of ['../evil', 'T-1/2', 'T-1\\2', 'T-1 2', '..']) {
      const { file } = stagedFile(Buffer.from('x'), 'a.diff');
      const error = await thrown(() => artifacts.upload({ task_id: bad, run_id: 'R-1' }, file));
      expect(error.code).toBe('VALIDATION_FAILED');
    }
    expect(existsSync(path.join(paths.dataDir(), 'evil'))).toBe(false);
    expect(await prisma.artifact.count()).toBe(0);
  });

  it('单文件超过 artifact_max_mb → 413 ARTIFACT_TOO_LARGE，临时文件被丢弃、不落库', async () => {
    const { taskId, runId } = await seedRun();
    await settings.patch({ artifact_max_mb: 1 });
    const { file, absolute } = stagedFile(Buffer.alloc(1024 * 1024 + 1, 0x61), 'big.txt');
    file.mimetype = 'text/plain';

    const error = await thrown(() =>
      artifacts.upload({ task_id: taskId, run_id: runId, mime_type: 'text/plain' }, file),
    );
    expect(error.code).toBe('ARTIFACT_TOO_LARGE');
    expect(error.status).toBe(413);
    expect(error.details).toMatchObject({ limit_bytes: 1024 * 1024 });
    expect(existsSync(absolute)).toBe(false);
    expect(await prisma.artifact.count()).toBe(0);
    expect(existsSync(path.resolve(paths.artifactsDir(), taskId))).toBe(false);
  });

  it('单 Run 累计超过 200 MB → 413 并写 warn 日志，半路文件不留在磁盘上（20.6）', async () => {
    const { taskId, runId } = await seedRun();
    await insertArtifact({
      uri: `artifacts/${taskId}/${runId}/${newId()}.bin`,
      type: 'file',
      sizeBytes: ARTIFACT_RUN_TOTAL_MAX_BYTES - 1,
    });
    const { file, absolute } = stagedFile(Buffer.from('tail'), 'tail.txt');
    file.mimetype = 'text/plain';

    const error = await thrown(() =>
      artifacts.upload({ task_id: taskId, run_id: runId, mime_type: 'text/plain' }, file),
    );
    expect(error.code).toBe('ARTIFACT_TOO_LARGE');
    expect(error.status).toBe(413);
    expect(logger.warn).toHaveBeenCalled();
    expect(await prisma.artifact.count()).toBe(1);
    // 同一条拒绝路径上，兄弟分支都会清掉临时文件；这里漏一次就是 6 小时的磁盘占用。
    expect(existsSync(absolute)).toBe(false);
  });
});

describe('元信息（GET /artifacts/{id}）', () => {
  it('正常产物：200、preview 开着，并附一次可用的签名 URL', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('+x\n'), 'a.diff');
    file.mimetype = 'text/x-diff';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);

    const meta = await artifacts.meta(uploaded.id);
    expect(meta).toMatchObject({
      id: uploaded.id,
      task_id: taskId,
      run_id: runId,
      type: 'diff',
      missing: false,
      size_bytes: 3,
      mime_type: 'text/x-diff',
      preview: { enabled: true, kind: 'diff', reason: null },
    });
    expect(meta.uri).toBe(uploaded.uri);
    expect(meta.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 13 章：元信息给的这个 URL 就是前端加载资源用的，必须真能核销一次。
    expect(meta.signed_url).toMatch(new RegExp(`^/api/v1/artifacts/${uploaded.id}/raw\\?`));
    expect(() => sign.consume(uploaded.id, 'raw', queryOf(meta.signed_url!))).not.toThrow();
    expect(meta.signed_url).not.toContain(UI_TOKEN);
  });

  it('missing：元信息仍 200 且带 missing=true，预览端点走 404 ARTIFACT_LOST（13 章）', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('0123456789'), 'a.txt');
    file.mimetype = 'text/plain';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);
    unlinkSync(path.resolve(paths.dataDir(), uploaded.uri));

    const meta = await artifacts.meta(uploaded.id);
    expect(meta.missing).toBe(true);
    expect(meta.signed_url).toBeNull();
    expect(meta.preview).toEqual({ enabled: false, kind: 'none', reason: 'file_missing' });
    expect(meta.size_bytes).toBe(10);

    const { res } = mockRes();
    const error = await thrown(() => artifacts.writeTo(uploaded.id, 'raw', res));
    expect(error.code).toBe('ARTIFACT_LOST');
    expect(error.status).toBe(404);
    expect(error.context).toMatchObject({ artifact_id: uploaded.id, uri: uploaded.uri });
  });

  it('库里 uri 越界（脏数据 / 手工写入）时按 missing 处理，绝不读那个路径', async () => {
    await seedRun();
    writeFileSync(path.join(dir, 'outside.txt'), 'secret bytes');
    const forged = [
      '/etc/passwd',
      '../outside.txt',
      'artifacts/../../outside.txt',
      `${paths.artifactsDir()}/T-1/R-1/x.txt`,
      'outside.txt',
    ];
    for (const uri of forged) {
      const row = await insertArtifact({ uri, type: 'text', mimeType: 'text/plain' });
      const meta = await artifacts.meta(row.id);
      expect({ uri, missing: meta.missing, signed: meta.signed_url }).toEqual({
        uri,
        missing: true,
        signed: null,
      });
      const error = await thrown(() => artifacts.writeTo(row.id, 'raw', mockRes().res));
      expect({ uri, code: error.code, status: error.status }).toEqual({
        uri,
        code: 'ARTIFACT_LOST',
        status: 404,
      });
      await prisma.artifact.delete({ where: { id: row.id } });
    }
  });

  it('阶段一的预览开关：diff/text/log/image 可预览，阶段二四类只给下载（6.10.1）', async () => {
    const { taskId, runId } = await seedRun();
    const cases: [string, string, 'diff' | 'text' | 'image' | 'none'][] = [
      ['diff', 'text/x-diff', 'diff'],
      ['text', 'text/plain', 'text'],
      ['log', 'text/plain', 'text'],
      ['image', 'image/png', 'image'],
      ['markdown', 'text/markdown', 'none'],
      ['json', 'application/json', 'none'],
      ['html', 'text/html', 'none'],
      ['pdf', 'application/pdf', 'none'],
      ['file', 'application/octet-stream', 'none'],
    ];
    for (const [type, mime, kind] of cases) {
      const absolute = path.resolve(paths.dataDir(), `artifacts/${taskId}/${runId}/${newId()}.${type}`);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'payload');
      const row = await insertArtifact({
        uri: path.relative(paths.dataDir(), absolute),
        type,
        mimeType: mime,
        sizeBytes: 7,
      });
      const meta = await artifacts.meta(row.id);
      expect({ type, preview: meta.preview }).toEqual({
        type,
        preview:
          kind === 'none'
            ? { enabled: false, kind: 'none', reason: 'renderer_not_in_stage1' }
            : { enabled: true, kind, reason: null },
      });
      await prisma.artifact.delete({ where: { id: row.id } });
      rmSync(absolute, { force: true });
    }
  });

  it('超过 artifact_max_mb 的产物只提供下载，不做内嵌预览（6.10.3）', async () => {
    const { taskId, runId } = await seedRun();
    await settings.patch({ artifact_max_mb: 1 });
    const absolute = path.resolve(paths.dataDir(), `artifacts/${taskId}/${runId}/${newId()}.log`);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'x');
    const row = await insertArtifact({
      uri: path.relative(paths.dataDir(), absolute),
      type: 'log',
      mimeType: 'text/plain',
      sizeBytes: 20 * 1024 * 1024,
    });

    const meta = await artifacts.meta(row.id);
    expect(meta.missing).toBe(false);
    expect(meta.preview).toEqual({ enabled: false, kind: 'none', reason: 'too_large' });
    // 下载仍然可用：上限只管内嵌渲染，不管取字节。
    const { res, body } = mockRes();
    await artifacts.writeTo(row.id, 'raw', res);
    expect(body().toString()).toBe('x');
  });

  it('link：不占磁盘、不算 missing，预览方式是 link，显示名不是裸 URL（20.6）', async () => {
    await seedRun();
    const row = await insertArtifact({
      uri: 'https://github.com/acme/app/pull/342',
      type: 'link',
      sizeBytes: null,
      mimeType: null,
      metadata: JSON.stringify({ name: 'PR #342' }),
    });

    const meta = await artifacts.meta(row.id);
    expect(meta).toMatchObject({
      missing: false,
      name: 'PR #342',
      size_bytes: null,
      mime_type: null,
      signed_url: null,
      preview: { enabled: true, kind: 'link', reason: null },
    });
    const error = await thrown(() => artifacts.writeTo(row.id, 'raw', mockRes().res));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
  });

  it('metadata 不是合法 JSON / 没有 name 时，显示名退回 uri 末段（20.7）', async () => {
    const { taskId, runId } = await seedRun();
    const id = newId();
    const absolute = path.resolve(paths.dataDir(), `artifacts/${taskId}/${runId}/${id}.txt`);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'x');
    const row = await insertArtifact({
      id,
      uri: path.relative(paths.dataDir(), absolute),
      type: 'text',
      metadata: '{ 这不是 JSON',
    });
    expect((await artifacts.meta(row.id)).name).toBe(`${id}.txt`);
  });

  it('产物不存在 / id 形状不符都是 NOT_FOUND', async () => {
    expect((await thrown(() => artifacts.meta(newId()))).code).toBe('NOT_FOUND');
    const bogus = await thrown(() => artifacts.meta('1 or ../../etc'));
    expect(bogus.code).toBe('NOT_FOUND');
    expect(bogus.status).toBe(404);
  });
});

describe('资源读取（GET /artifacts/{id}/raw 与 /thumbnail）', () => {
  it('响应头满足 15 章硬约束：nosniff、CSP、Content-Disposition、no-store，字节原样', async () => {
    const { taskId, runId } = await seedRun();
    const payload = Buffer.from('--- a/x.ts\n+++ b/x.ts\n+const a = 1\n');
    const { file } = stagedFile(payload, 'a.diff');
    file.mimetype = 'text/x-diff';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);

    const { res, headers, body } = mockRes();
    await artifacts.writeTo(uploaded.id, 'raw', res);

    expect(body()).toEqual(payload);
    expect(headers.get('content-type')).toBe('text/x-diff');
    expect(headers.get('content-length')).toBe(String(payload.length));
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    // 验收 17：页面源（tauri://localhost / 127.0.0.1:5173）与资源源（127.0.0.1:<port>）必然跨源，
    // same-origin 会把图片内嵌打死；改 cross-origin 后 nosniff 与 CSP sandbox 仍在原位。
    expect(headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('x-atb-artifact-type')).toBe('diff');
    // 非图片一律 attachment：Agent 上传的内容不能在浏览器里就地渲染。
    expect(headers.get('content-disposition')).toContain('attachment');
    expect(headers.get('content-disposition')).toContain("filename*=UTF-8''a.diff");
  });

  it('图片的 raw 是 inline，thumbnail 两个 variant 各自可取', async () => {
    const { taskId, runId } = await seedRun();
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const { file } = stagedFile(png, 'shot.png');
    file.mimetype = 'image/png';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);

    const raw = mockRes();
    await artifacts.writeTo(uploaded.id, 'raw', raw.res);
    expect(raw.headers.get('content-disposition')).toContain('inline');
    expect(raw.headers.get('content-type')).toBe('image/png');

    const thumb = mockRes();
    await artifacts.writeTo(uploaded.id, 'thumbnail', thumb.res);
    expect(thumb.headers.get('x-atb-thumbnail')).toBe('passthrough');
    expect(thumb.headers.get('content-disposition')).toContain('attachment');
    expect(thumb.body()).toEqual(png);
  });

  it('非图片没有缩略图：NOT_FOUND，不返回原图', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('text'), 'a.txt');
    file.mimetype = 'text/plain';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);

    const kind: SignedKind = 'thumbnail';
    const error = await thrown(() => artifacts.writeTo(uploaded.id, kind, mockRes().res));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
  });
});

describe('diff 解析（GET /artifacts/{id}/diff）', () => {
  it('返回按文件/块分行的结构，行号在服务端算好', async () => {
    const { taskId, runId } = await seedRun();
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111..2222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2b',
      '+line3b',
      ' line4',
    ].join('\n');
    const { file } = stagedFile(Buffer.from(diff), 'change.diff');
    file.mimetype = 'text/x-diff';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);

    const result = await artifacts.diff(uploaded.id);
    expect(result.name).toBe('change.diff');
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/a.ts');
    expect(result.files[0]?.additions).toBe(2);
    expect(result.files[0]?.deletions).toBe(1);
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.files[0]?.hunks[0]?.lines.map((line) => line.type)).toEqual([
      'ctx',
      'del',
      'add',
      'add',
      'ctx',
    ]);
  });

  it('非文本类型 422，缺失文件 404 ARTIFACT_LOST', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('x'), 'shot.png');
    file.mimetype = 'image/png';
    const image = await artifacts.upload({ task_id: taskId, run_id: runId }, file);
    expect((await thrown(() => artifacts.diff(image.id))).code).toBe('VALIDATION_FAILED');

    const missingRow = await insertArtifact({ uri: `artifacts/${taskId}/${runId}/${newId()}.diff`, type: 'diff' });
    const error = await thrown(() => artifacts.diff(missingRow.id));
    expect(error.code).toBe('ARTIFACT_LOST');
    expect(error.status).toBe(404);
  });
});

describe('级联清理（4.3.1 规则 4）', () => {
  it('删任务目录时把该任务的全部产物带走，包括库里没有的残留文件', async () => {
    const { taskId, runId } = await seedRun();
    const { file } = stagedFile(Buffer.from('x'), 'a.txt');
    file.mimetype = 'text/plain';
    const uploaded = await artifacts.upload({ task_id: taskId, run_id: runId }, file);
    const orphan = path.resolve(paths.dataDir(), `artifacts/${taskId}/${runId}/orphan.txt`);
    writeFileSync(orphan, 'orphan');
    const other = path.resolve(paths.artifactsDir(), 'T-2', 'R-9');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'keep.txt'), 'keep');

    expect(artifacts.cleanupTaskDir(taskId)).toEqual({ removed: true });
    expect(existsSync(path.resolve(paths.artifactsDir(), taskId))).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path.resolve(paths.dataDir(), uploaded.uri))).toBe(false);
    // 别的任务目录不受牵连
    expect(existsSync(path.join(other, 'keep.txt'))).toBe(true);
    expect(artifacts.cleanupTaskDir(taskId)).toEqual({ removed: false });
    expect(artifacts.artifactsRoot()).toBe(paths.artifactsDir());
    rmSync(paths.artifactsDir(), { force: true, recursive: true });
    expect(existsSync(artifacts.artifactsRoot())).toBe(true);
  });

  it('task_id 不能用作目录名时直接拒绝，不去删 dataDir', async () => {
    for (const bad of ['../', '..', 'a/b', '']) {
      expect((await thrown(() => artifacts.cleanupTaskDir(bad))).code).toBe('VALIDATION_FAILED');
    }
    expect(existsSync(path.join(dir, 'artifacts'))).toBe(true);
  });
});
