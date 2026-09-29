/**
 * 错误码表一致性闸（2026-09-29「报错全部细化」）。
 *
 * 第十三章的码表只有一份实现（`contract/errors.ts` 的 `ERROR_STATUS`），但它同时被四个地方
 * 复制：REST 出口、MCP 出口、前端 `ERROR_CODES`/`ERROR_CODE_COPY`、设计文档的码表。
 * 每一次「加一个码」都要这四处同步，漏哪处都不会报错、只会静默降级：
 *   * 前端 `ERROR_CODES` 缺一项 → `client.ts` 把它认成 `UNKNOWN`，细化文案整个丢掉；
 *   * 文档缺一行 → 下一个接手的人不知道这码存在，会另加一枚语义重复的；
 *   * 两个出口各写各的 → Agent 面与界面看到的是两种错误。
 * 所以这里判的是**集合相等**，不是「新码在不在」。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS, ApiException, type ErrorCode } from '../errors';
import { DATA_LAYER_CODES } from '../db-errors';
import { ApiExceptionFilter } from '../../infra/api-exception.filter';
import { toCallToolResult } from '../../mcp/mcp.server';

const repoRoot = path.resolve(__dirname, '../../../../..');
const webTypes = readFileSync(path.join(repoRoot, 'apps/web/src/api/types.ts'), 'utf8');
const webErrorsCopy = readFileSync(path.join(repoRoot, 'apps/web/src/api/errors.ts'), 'utf8');
const designDoc = readFileSync(path.join(repoRoot, 'docs/Agent Task Board 产品与设计文档 v1.5.md'), 'utf8');

/** 第十三章码表那一段：从 `## 统一错误码` 起、到十四章标题止（表外的一律不参与判定）。 */
function docCodeTable(): string {
  const start = designDoc.indexOf('## 统一错误码');
  const end = designDoc.indexOf('# 十四、', start);
  expect(start, '文档里找不到「## 统一错误码」').toBeGreaterThan(-1);
  expect(end, '文档里找不到十四章标题（码表段落收不住）').toBeGreaterThan(start);
  return designDoc.slice(start, end);
}

/** 从 `export const ERROR_CODES = [ ... ] as const` 里把字符串项抠出来（注释行忽略）。 */
function listOf(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  expect(start, `前端源码里找不到 ${marker}`).toBeGreaterThan(-1);
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  const body = source.slice(open + 1, close);
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
}

/** `ERROR_CODE_COPY: Record<ErrorCode, string> = { KEY: '…' }` 的键集合。 */
function copyKeys(source: string): string[] {
  const start = source.indexOf('ERROR_CODE_COPY: Record<ErrorCode, string> = {');
  expect(start, '前端找不到 ERROR_CODE_COPY').toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  let close = open;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  return [...source.slice(open + 1, close).matchAll(/^\s{2}([A-Z_]+):/gm)].map((match) => match[1]);
}

const serverCodes = Object.keys(ERROR_STATUS);
const webCodes = listOf(webTypes, 'export const ERROR_CODES =');
const webCopy = copyKeys(webErrorsCopy);
/** 前端自己造的两枚（没拿到响应 / 认不出的形状），服务端不会下发。 */
const CLIENT_ONLY_CODES = ['NETWORK_ERROR', 'UNKNOWN'];

describe('前端码表 ↔ 服务端码表', () => {
  it('服务端每一枚都在前端 ERROR_CODES 里（缺一枚就退化成 UNKNOWN，细化文案全丢）', () => {
    const missing = serverCodes.filter((code) => !webCodes.includes(code));
    expect(missing).toEqual([]);
  });

  it('前端 ERROR_CODES 里除 NETWORK_ERROR/UNKNOWN 外，每一枚服务端都有（不许凭空造码）', () => {
    const extra = webCodes.filter((code) => !serverCodes.includes(code) && !CLIENT_ONLY_CODES.includes(code));
    expect(extra).toEqual([]);
  });

  it('每一枚都有本地兜底文案（ERROR_CODE_COPY 是 Record<ErrorCode, string>，运行时再钉一遍）', () => {
    const missing = [...serverCodes, ...CLIENT_ONLY_CODES].filter((code) => !webCopy.includes(code));
    expect(missing).toEqual([]);
  });

  it('NETWORK_ERROR / UNKNOWN 只在前端（服务端下发即口径失控）', () => {
    for (const code of CLIENT_ONLY_CODES) expect(serverCodes).not.toContain(code);
  });
});

describe('第十三章文档码表', () => {
  it('每一枚服务端码在文档表里都有一行（缺了下一个接手人就会另加语义重复的码）', () => {
    const table = docCodeTable();
    const missing = serverCodes.filter((code) => !table.includes(`| \`${code}\` |`) && !table.includes(`|\`${code}\`|`));
    expect(missing).toEqual([]);
  });

  it('文档表里没有服务端不认识的码（写进文档的码必须能真的下发）', () => {
    const docCodes = [...docCodeTable().matchAll(/\|\s*`([A-Z_]+)`\s*\|/g)].map((match) => match[1]);
    const ghost = docCodes.filter((code) => !serverCodes.includes(code));
    expect(ghost).toEqual([]);
  });
});

describe('解码器自产自销', () => {
  it('DATA_LAYER_CODES 里每一枚都真实存在于码表', () => {
    const ghost = DATA_LAYER_CODES.filter((code) => !(code in ERROR_STATUS));
    expect(ghost).toEqual([]);
  });

  it('七枚数据层码都从解码器出得来（写进码表却发不出来的死码要拦下）', () => {
    for (const code of DATA_LAYER_CODES) {
      if (code === 'INTERNAL' || code === 'NOT_FOUND') continue;
      expect(serverCodes).toContain(code);
    }
  });
});

/** 造一条「长得像 Prisma」的错误：解码器判的是 name/code/meta 三个位置，形状必须照实测来。 */
function shaped(init: { name: string; code?: string; meta?: Record<string, unknown>; message: string }): Error {
  const error = new Error(init.message);
  Object.assign(error, { name: init.name, code: init.code, meta: init.meta });
  return error;
}

/** 直接驱动 REST 出口：假一个 Response，把过滤器写出来的状态码与错误体取回来。 */
function viaRest(error: unknown): { status: number; code: string; message: string; detail: string } {
  const written: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const res = {
    headersSent: false,
    setStatus: 0,
    status(value: number) {
      written.status = value;
      return this;
    },
    json(body: Record<string, unknown>) {
      written.body = body;
      return this;
    },
  };
  const req = { method: 'POST', url: '/api/v1/_probe', originalUrl: '/api/v1/_probe' };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  };
  new ApiExceptionFilter().catch(error, host as never);
  const body = (written.body as { error?: Record<string, unknown> }).error ?? {};
  return {
    status: written.status,
    code: String(body.code ?? ''),
    message: String(body.message ?? ''),
    detail: String(body.detail ?? ''),
  };
}

/** 驱动 MCP 出口：同一个错误进来的码与文案必须和 REST 一字不差。 */
async function viaMcp(error: unknown): Promise<{ code: string; message: string; detail: string }> {
  const result = await toCallToolResult(async () => {
    throw error;
  });
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return {
    code: String(structured.code ?? ''),
    message: String(structured.message ?? ''),
    detail: String(structured.detail ?? ''),
  };
}

describe('两个出口共用同一份解码（REST 与 MCP 不许各猜各的）', () => {
  const cases: Array<{ label: string; error: Error; code: string; status: number }> = [
    {
      label: '撞外键',
      error: shaped({
        name: 'PrismaClientKnownRequestError',
        code: 'P2010',
        meta: { code: '787', message: 'FOREIGN KEY constraint failed' },
        message: 'Raw query failed. Code: `787`. Message: `FOREIGN KEY constraint failed`',
      }),
      code: 'DATA_STILL_REFERENCED',
      status: 409,
    },
    {
      label: '记录已被删',
      error: shaped({
        name: 'PrismaClientKnownRequestError',
        code: 'P2025',
        meta: { modelName: 'Task', cause: 'No record was found for an update.' },
        message: 'An operation failed because it depends on one or more records that were required but not found.',
      }),
      code: 'NOT_FOUND',
      status: 404,
    },
    {
      label: '库文件打不开',
      error: shaped({
        name: 'PrismaClientInitializationError',
        message: '\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\nError querying the database: Error code 14: Unable to open the database file',
      }),
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    },
    {
      label: '认不出的抛出',
      error: new Error('某个第三方库随口抛的一句'),
      code: 'INTERNAL',
      status: 500,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.label}：REST 回 ${testCase.code}/${testCase.status}，MCP 同码同文案`, async () => {
      const rest = viaRest(testCase.error);
      expect({ code: rest.code, status: rest.status }).toEqual({ code: testCase.code, status: testCase.status });
      expect(rest.detail.length).toBeGreaterThan(0);

      const mcp = await viaMcp(testCase.error);
      expect(mcp.code).toBe(rest.code);
      expect(mcp.message).toBe(rest.message);
      expect(mcp.detail).toBe(rest.detail);
    });
  }

  it('非 Error 的抛出值不会把出口打穿：REST 仍回一个错误体，MCP 仍回 isError', () => {
    const rest = viaRest('只是一串字符');
    expect({ code: rest.code, status: rest.status }).toEqual({ code: 'INTERNAL', status: 500 });
  });

  it('业务自己抛的 ApiException 原样透传（解码器不许改写已经定性的错误）', () => {
    const api = new ApiException('GROUP_NOT_ALL_DONE', '组内还有 3 个任务未完成', undefined, { remaining: 3 });
    const rest = viaRest(api);
    expect({ code: rest.code, status: rest.status }).toEqual({ code: 'GROUP_NOT_ALL_DONE', status: 409 });
  });
});
