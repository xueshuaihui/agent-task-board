import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ApiError, api, errorCodeOf, qk, setUiToken } from '@/api';
import { ToastProvider } from '@/components/ui';

/**
 * 2026-09-29「列表三态必须可辨」（走查第二轮，与「报错全部细化」同一处病灶）。
 *
 * 病形：设置页几个 Tab 握着一份 TanStack Query 列表结果，**却从不渲染它的 `error`**。
 * 服务端 500（`SCHEMA_MISMATCH`，实测把 `api_tokens` 表改名即可复现：`GET /tokens` 回
 * `{error:{code:'SCHEMA_MISMATCH',message:'本地数据库缺少表「api_tokens」…'}}`）时，
 * `query.data` 是 undefined ⇒ `items` 是 `[]` ⇒ 界面照旧摆出「还没有 Token。生成一个后…」——
 * 失败被空态吃掉，用户以为自己是真的没有数据。
 *
 * 模型（已拍板，不在这里重开）：一份列表有三种必须分得开的状态，
 * `isPending` 给骨架 / `isError` 给错误面 / 真的读到零行才给空态；
 * **错误态永远不得渲染空态、0 或任何「没有数据」的暗示**。
 *
 * 环境口径同 `board/__tests__/column-always-open.test.ts` 与 `ui/__tests__/error-copy.test.ts`：
 * 本仓 vitest 无 DOM（未装 jsdom / @testing-library），故先 stub 最小 `window`（`@/api/env` 与
 * `@/app/desktop` 都要读浏览器全局）再动态 import 组件，用 `renderToStaticMarkup` 渲真实 Tab、
 * 对 HTML 做字符串断言。错误是**喂进缓存**的：`fetch` 打成 500 → 走真实 `client.ts` 的
 * 错误体解析 → `prefetchQuery` 把 `ApiError` 落到 `qk` 那个 key 上，于是组件首帧看到的就是
 * 错误态（不是先渲染一帧骨架）。
 */

const TABS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../tabs');

vi.stubGlobal('window', {
  location: { hash: '#/settings?tab=tokens', href: 'http://127.0.0.1:5173/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const { TokensTab } = await import('../tabs/tokens');
const { BackupsTab } = await import('../tabs/backups');
const { useBackupList } = await import('../queries');

afterAll(() => {
  vi.unstubAllGlobals();
});

/** 走真实读路径要有 UI Token（`client.ts` 拿不到就本地造一条 UNAUTHORIZED，测不到服务端错误体）。 */
setUiToken('test-ui-token-for-settings-list-three-states');

/** 「路径片段 → 结局」；没列出的路径回 200 + 空对象（本用例不关心它）。 */
function stubFetch(routes: Record<string, { status: number; body: unknown }>): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([needle]) => url.includes(needle));
    const outcome = hit?.[1] ?? { status: 200, body: {} };
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/**
 * 一个用例一个 client：缓存里那份状态就是组件首帧看到的状态。
 *
 * 两件事必须显式按住，否则 `prefetchQuery` 落的错误在渲染时会被**重置回 pending**（组件于是
 * 又摆出骨架，测不到错误态那一支）：
 * - `retryOnMount: false` —— react-query 的乐观结果算法里，`data === undefined` 且
 *   `status === 'error'` 的条目在挂载时默认「还要再读一次」，首帧状态被改写回 pending；
 *   关掉它，缓存里的错误态才原样透出（`renderToStaticMarkup` 不跑 effect，本就没有第二次请求）。
 * - `gcTime` 不给 0 —— 无人观察的条目会被立刻回收，错误也就跟着没了。
 */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: 60_000 } },
  });
}

function renderTab(client: QueryClient, tab: ReactNode): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ToastProvider, null, tab),
    ),
  );
}

/** 500：`GET /tokens` 的实测回包形状（服务端 message 已经把「怎么办」写出来了）。 */
const TOKENS_500 = {
  '/tokens': {
    status: 500,
    body: {
      error: {
        code: 'SCHEMA_MISMATCH',
        message: '本地数据库缺少表「api_tokens」，请重启本地服务',
        detail: 'SqliteFailure: (1, "no such table: main.api_tokens")',
      },
    },
  },
};

describe('Token Tab：列表错误面替掉空态（主面档）', () => {
  it('GET /tokens 500 → 摆服务端 message + 「详情」折叠，且「还没有 Token」不再出现', async () => {
    stubFetch(TOKENS_500);
    const client = newClient();
    await client.prefetchQuery({ queryKey: qk.tokens(), queryFn: () => api.tokens.list() });

    const html = renderTab(client, createElement(TokensTab));
    expect(html).toContain('本地数据库缺少表「api_tokens」');
    expect(html).toContain('详情');
    expect(html).toContain('aria-expanded="false"');
    // 引擎原文默认不摊在界面上（折叠点开才有）。
    expect(html).not.toContain('no such table');
    // 这一条是本片的靶心：错误态不得渲染空态。
    expect(html).not.toContain('还没有 Token');
    expect(html).not.toContain('生成一个后把它填进');
  });

  it('GET /tokens 200 且真的零条 → 仍是空态（三态没被并成两态）', async () => {
    stubFetch({});
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.tokens(),
      queryFn: async () => ({ items: [] }),
    });

    const html = renderTab(client, createElement(TokensTab));
    expect(html).toContain('还没有 Token');
    expect(html).not.toContain('详情');
    expect(html).not.toContain('animate-shimmer');
  });

  it('还没读到结果（isPending）→ 给骨架，既不摆空态也不摆错误面', () => {
    stubFetch(TOKENS_500);
    // 不 prefetch：首帧就是 pending（`renderToStaticMarkup` 不跑 effect，请求不会落地）。
    const html = renderTab(newClient(), createElement(TokensTab));
    expect(html).toContain('animate-shimmer');
    expect(html).not.toContain('还没有 Token');
    expect(html).not.toContain('SCHEMA_MISMATCH');
  });
});

describe('useBackupList：结构上不再吞掉 query.error', () => {
  it('查询失败时原样带出 ApiError，items/totalSize 仍按空值渲染', async () => {
    // 服务端只给了通用兜底句 → `errorMessage` 回落到本地码表（STORAGE_READONLY 那一行）。
    stubFetch({
      '/settings/backups': {
        status: 500,
        body: {
          error: {
            code: 'STORAGE_READONLY',
            message: '服务内部错误',
            detail: 'SqliteFailure: attempt to write a readonly database',
          },
        },
      },
    });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.backups(),
      queryFn: () => api.settings.backups(),
    });

    const captured: { value?: ReturnType<typeof useBackupList> } = {};
    function Harness(): null {
      captured.value = useBackupList();
      return null;
    }
    renderTab(client, createElement(Harness));

    expect(captured.value).toBeDefined();
    expect(captured.value?.items).toEqual([]);
    expect(captured.value?.totalSize).toBe(0);
    expect(captured.value?.error).toBeInstanceOf(ApiError);
    expect(errorCodeOf(captured.value?.error)).toBe('STORAGE_READONLY');
  });

  it('备份 Tab 在 500 下摆错误面，不再摆「共 0 B」/「还没有备份。」/「备份列表（0）」', async () => {
    stubFetch({
      '/settings/backups': {
        status: 500,
        body: {
          error: {
            code: 'STORAGE_READONLY',
            message: '服务内部错误',
            detail: 'SqliteFailure: attempt to write a readonly database',
          },
        },
      },
    });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.backups(),
      queryFn: () => api.settings.backups(),
    });

    const html = renderTab(client, createElement(BackupsTab));
    expect(html).toContain('本地数据目录当前不可写');
    expect(html).toContain('详情');
    expect(html).not.toContain('还没有备份');
    expect(html).not.toContain('共 0');
    expect(html).not.toContain('备份列表（0）');
    // 「立即备份」按钮不能被错误态吃掉（读失败不等于写不了）。
    expect(html).toContain('立即备份');
  });
});

/**
 * 源码闸：这一类 bug 的形状是「握着列表结果、只渲染空态」，字符串断言只能逐个覆盖，
 * 这里给一条**覆盖整片**的闸：五个列表 Tab 必须都摆出列表错误面（`InlineError` 里套
 * `<ErrorCopy>`），且同时有错误分支与加载分支；吃 `GET /settings` 的四个 Tab 必须把
 * 读失败（`loadError`）单独渲染出来——只有写失败可见的话，读失败仍然整片隐身。
 */
describe('设置页同类区域闸（报一个点=修整片同类区域）', () => {
  const LIST_TABS = ['tokens.tsx', 'templates.tsx', 'fields.tsx', 'logs.tsx', 'backups.tsx'];
  const SETTINGS_TABS = ['general.tsx', 'mcp.tsx', 'logs.tsx', 'data.tsx'];

  it('五个列表 Tab 都有列表错误面，且错误分支与加载分支都在', () => {
    for (const name of LIST_TABS) {
      const source = readFileSync(join(TABS_DIR, name), 'utf8');
      expect(source, `${name} 应把列表错误摆进界面`).toMatch(/InlineError text=\{<ErrorCopy error=/);
      expect(source, `${name} 应区分错误态`).toMatch(/isError|listError/);
      expect(source, `${name} 应区分加载态`).toMatch(/isPending|isLoading/);
    }
  });

  it('四个吃设置的 Tab 都渲染了读失败（loadError），不只是写失败', () => {
    for (const name of SETTINGS_TABS) {
      const source = readFileSync(join(TABS_DIR, name), 'utf8');
      expect(source, `${name} 应渲染设置读失败`).toMatch(/loadError/);
    }
  });
});
