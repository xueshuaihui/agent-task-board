import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_CODE_COPY, errorDetailOf, errorMessage } from '@/api';
import { ErrorCopy, ErrorDetail, ErrorText } from '@/components/ui';

/**
 * 就地错误面（2026-09-29「报错全部细化」拍板②）：细化文案 + 折叠详情。
 *
 * 环境口径同 `column-always-open.test.ts`：本仓 vitest 无 DOM（未装 jsdom / @testing-library），
 * 所以用 `renderToStaticMarkup` 渲真组件、对 HTML 做字符串断言。「点了才展开」那一步
 * 是交互，交给浏览器实测（三档窗口宽）；这里钉的是**默认态**：
 * 主行是细化文案、折叠入口按有没有原文出现、原文本身默认不摊在界面上。
 *
 * 最后一组是源码闸：`.tsx` 里再出现 `error.message` 就等于绕开码表兜底，
 * 认不出的错误会把内部话术原样糊到界面上——这次整片就是这么修掉的，不许回潮。
 */

const STORAGE_LOCKED = new ApiError({
  code: 'STORAGE_LOCKED',
  message: '本地数据库没有及时响应（通常是另一个进程正占着它写，或同时开了两个本地服务）。请等待片刻重试',
  status: 503,
  context: { detail: 'Socket timeout (the database failed to respond to a query within 5000ms)' },
});

const GENERIC_INTERNAL = new ApiError({
  code: 'INTERNAL',
  message: '服务内部错误',
  status: 500,
  context: { prisma_code: 'P2010', detail: 'SqliteFailure: (1, "no such table: main.groups")' },
});

describe('细化文案与折叠详情的取数', () => {
  it('服务端 message 已经解出来的，原样给用户看，不再一刀切成「本地服务内部错误」', () => {
    expect(errorMessage(STORAGE_LOCKED)).toContain('另一个进程');
    expect(errorMessage(STORAGE_LOCKED)).not.toContain('内部错误');
  });

  it('服务端只给了通用兜底句时，回落到本地码表（这里给的是 503 的 STORAGE_LOCKED 口径）', () => {
    expect(errorMessage(new ApiError({ code: 'STORAGE_LOCKED', message: 'Internal Server Error' }))).toBe(
      ERROR_CODE_COPY.STORAGE_LOCKED,
    );
    // INTERNAL 没有可用的服务端信息，码表那句仍然带「本地服务」主语，不说 stack。
    expect(errorMessage(GENERIC_INTERNAL)).toBe(ERROR_CODE_COPY.INTERNAL);
  });

  it('折叠详情取 `context.detail`；没有原文就没有入口', () => {
    expect(errorDetailOf(STORAGE_LOCKED)).toContain('Socket timeout');
    expect(errorDetailOf(new ApiError({ code: 'NOT_FOUND', message: '资源不存在' }))).toBeUndefined();
  });

  it('详情与主行重复时不再单独给一行（同一个字符串摊两遍是噪音）', () => {
    const same = new ApiError({ code: 'SCHEMA_MISMATCH', message: '缺表 groups', context: { detail: '缺表 groups' } });
    expect(errorDetailOf(same)).toBeUndefined();
  });
});

describe('ErrorCopy / ErrorDetail / ErrorText 的默认态', () => {
  const html = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);

  it('主行是细化文案，「详情」入口在，但引擎原文默认不摊出来', () => {
    const markup = html(createElement(ErrorCopy, { error: STORAGE_LOCKED }));
    expect(markup).toContain('另一个进程');
    expect(markup).toContain('详情');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('Socket timeout');
  });

  it('没有原文的错误不摆一个点了没反应的按钮', () => {
    const markup = html(createElement(ErrorCopy, { error: new ApiError({ code: 'NOT_FOUND', message: '任务不存在' }) }));
    expect(markup).toContain('任务不存在');
    expect(markup).not.toContain('详情');
  });

  it('主行由调用方拼好时（422 并了逐字段路径），文案不被 `errorMessage` 覆盖，详情仍在', () => {
    const markup = html(
      createElement(ErrorText, {
        text: '有字段未通过校验（priority：需为数字）',
        error: GENERIC_INTERNAL,
      }),
    );
    expect(markup).toContain('priority：需为数字');
    expect(markup).not.toContain(ERROR_CODE_COPY.INTERNAL);
    expect(markup).toContain('详情');
  });

  it('`ErrorDetail` 空串时整块不渲染', () => {
    expect(html(createElement(ErrorDetail, { text: '   ' }))).toBe('');
    expect(html(createElement(ErrorDetail, { text: undefined }))).toBe('');
  });
});

/**
 * 源码闸：递归扫 `src` 下的全部 `.tsx`。
 *
 * 判据钉的是 **`something.error.message`** 这个形状——从 react-query / mutation 状态上直接取原始
 * message 去渲染，就是绕开 `errorMessage` 的码表兜底，正是本次「一片就地错误面都在吐原始
 * message」的病灶。本地 `catch (error)` 里拼一句 `new Error(...)`（导入中心的 JSON 解析包装）
 * 不在这个面里：那是在构造错误，不是在展示服务端错误，硬把它算进来只会逼着代码改名避让。
 * 构造 `ApiError` 的两处本身是 `.ts`，扫描面只收 `.tsx`。
 */
describe('就地错误面不再直接吐 error.message', () => {
  const SRC = path.resolve(process.cwd(), 'src');

  const tsxFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__') continue;
        out.push(...tsxFiles(full));
      } else if (name.endsWith('.tsx')) {
        out.push(full);
      }
    }
    return out;
  };

  it('没有任何 .tsx 直接渲染 X.error.message', () => {
    const offenders = tsxFiles(SRC)
      .filter((file) => /\.error\s*\??\s*\.\s*message/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
