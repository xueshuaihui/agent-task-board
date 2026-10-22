import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { api, qk, setUiToken } from '@/api';
import type {
  ClientDetectResult,
  ClientEntryPlan,
  ClientEntryPlanAction,
} from '@/api/types';
import type { DialogProps } from '@/components/ui';

/**
 * v0.0.4 W9 设置 → 客户端入口的 SSR 单测（切片 F）。
 *
 * 环境口径同 `list-three-states.test.ts`：本仓 vitest 是 node 环境，没有 DOM；先 stub 最小
 * `window`，再动态 import 真实组件，用 `renderToStaticMarkup` 对 HTML 做字符串/正则断言。
 * 首帧状态靠 `prefetchQuery` 喂进缓存（`renderToStaticMarkup` 不跑 effect）。
 *
 * 唯一的模块替身是 `Dialog`：真实实现走 Radix Portal，Node 里没有 `document`，弹窗正文整个
 * 不渲染。这里只把它换成一个平铺的 `<section>`（title + children + footer，`open=false` 回
 * null），Button / Badge / Checkbox / ToastProvider 等一律用原实现——否则测的就不是真实 UI。
 * 工厂里动态 `await import('react')`，避免 `vi.mock` 提升后引用尚未初始化的顶层变量。
 */

vi.mock('@/components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui')>();
  const react = await import('react');
  return {
    ...actual,
    Dialog: (props: DialogProps) =>
      props.open
        ? react.createElement(
            'section',
            { 'data-dialog-stub': 'open' },
            props.title === undefined ? null : react.createElement('h2', null, props.title),
            props.children,
            props.footer === undefined ? null : react.createElement('footer', null, props.footer),
          )
        : null,
  };
});

vi.stubGlobal('window', {
  location: { hash: '#/settings?tab=client-entry', href: 'http://127.0.0.1:5173/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});

const { ClientEntryTab } = await import('../tabs/client-entry');
const { ClientCard } = await import('../client-entry/client-card');
const { PlanDialog } = await import('../client-entry/plan-dialog');
const { SelfTestDialog } = await import('../client-entry/self-test-dialog');
const { ToastProvider } = await import('@/components/ui');

afterAll(() => {
  vi.unstubAllGlobals();
});

/** 走真实读路径要有 UI Token（`client.ts` 拿不到就本地造一条 UNAUTHORIZED）。 */
setUiToken('test-ui-token-for-client-entry-ssr-0001');

const WORKSPACE = '/tmp/atb-client-entry-ws';
const SELF_TEST_PATH = '/client-entries/self-test';

/** 「路径片段 → 结局」；没列出的路径回 200 + 空对象。 */
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

interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

/** 捕获式 fetch：回一份固定 JSON，同时记下 URL / method / 解析后的请求体。 */
function captureFetch(body: unknown, status = 200): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

/** 一个用例一个 client：缓存里那份状态就是组件首帧看到的状态（见 list-three-states 的注释）。 */
function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, gcTime: 60_000 } },
  });
}

function renderNode(client: QueryClient, node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, node)),
  );
}

/* ------------------------------------------------------------------ 六端 fixture */

/**
 * 一律按服务端台账/契约的 snake_case 原样回包（`write_mode` / `effect_hint` / `server_name` …），
 * 让这组用例顺带覆盖 `resources/client-entries.ts` 的映射，而不是只测「已经 camelCase 的假数据」。
 */
function rawTarget(
  scope: 'project' | 'user',
  asset: 'rule' | 'skill',
  path: string,
  writeMode: 'file' | 'managed_block' = 'file',
) {
  return {
    scope,
    asset,
    path,
    write_mode: writeMode,
    confidence: 'confirmed',
    exists: false,
  };
}

const SELF_TEST_RAW = {
  server_name: 'jarvis-workbench',
  mcp_endpoint: 'http://127.0.0.1:7788/mcp',
  wake_mode: 'continuous',
  recent: [
    {
      id: 'wake-overview-1',
      source: 'qoder',
      token_name: 'local-ui',
      received_at: '2026-10-23T09:00:00.000Z',
    },
  ],
};

const RAW_CLIENTS = [
  {
    client: 'qoder',
    label: 'Qoder',
    assets: ['rule', 'skill'],
    scopes: ['project', 'user'],
    stability: { rule: 'stable', skill: 'stable' },
    notes: ['用户级优先使用已存在的 ~/.qoder-cn，其次 ~/.qoder。'],
    detected: { project: true, user: true },
    targets: [
      rawTarget('project', 'rule', `${WORKSPACE}/.qoder/rules/jarvis.md`, 'managed_block'),
      rawTarget('project', 'skill', `${WORKSPACE}/.qoder/skills/jarvis/SKILL.md`),
    ],
    entries: [
      {
        id: 'ce-qoder-rule',
        client: 'qoder',
        scope: 'project',
        workspace_path: WORKSPACE,
        asset_type: 'rule',
        asset_name: 'jarvis',
        target_path: `${WORKSPACE}/.qoder/rules/jarvis.md`,
        write_mode: 'managed_block',
        status: 'installed',
        template_version: 1,
        installed_at: '2026-10-20T08:00:00.000Z',
        verified_at: '2026-10-21T08:00:00.000Z',
        last_error: null,
        update_available: true,
      },
    ],
    effect_hint: { project: '新开会话后生效', user: '新开会话后生效' },
  },
  {
    client: 'cursor',
    label: 'Cursor',
    assets: ['rule', 'skill'],
    scopes: ['project'],
    stability: { rule: 'stable', skill: 'experimental' },
    notes: ['Cursor 只提供项目级入口。'],
    detected: { project: false, user: false },
    targets: [
      rawTarget('project', 'rule', `${WORKSPACE}/.cursor/rules/jarvis.mdc`),
      rawTarget('project', 'skill', `${WORKSPACE}/.cursor/skills/jarvis/SKILL.md`),
    ],
    entries: [],
    effect_hint: { project: '在 Cursor 执行 Reload Window 后生效', user: '' },
  },
  {
    client: 'cline',
    label: 'Cline',
    assets: ['rule'],
    scopes: ['project', 'user'],
    stability: { rule: 'stable', skill: 'experimental' },
    notes: ['Cline 只支持入口规则，不支持操作技能。'],
    detected: { project: true, user: true },
    targets: [rawTarget('project', 'rule', `${WORKSPACE}/.clinerules/jarvis.md`)],
    entries: [],
    effect_hint: { project: '新开任务后生效', user: '新开任务后生效' },
  },
  {
    client: 'windsurf',
    label: 'Windsurf',
    assets: ['rule'],
    scopes: ['project', 'user'],
    stability: { rule: 'stable', skill: 'experimental' },
    notes: ['Windsurf 只支持入口规则，全局规则有 6000 字上限。'],
    detected: { project: false, user: true },
    targets: [rawTarget('project', 'rule', `${WORKSPACE}/.windsurf/rules/jarvis.md`)],
    entries: [],
    effect_hint: { project: '重载 Windsurf 后生效', user: '重载 Windsurf 后生效' },
  },
  {
    client: 'claude_code',
    label: 'Claude Code',
    assets: ['rule', 'skill'],
    scopes: ['project', 'user'],
    stability: { rule: 'stable', skill: 'stable' },
    notes: ['规则写入 CLAUDE.md 的托管块；技能写入独立 SKILL.md。'],
    detected: { project: true, user: true },
    targets: [
      rawTarget('project', 'rule', `${WORKSPACE}/CLAUDE.md`, 'managed_block'),
      rawTarget('project', 'skill', `${WORKSPACE}/.claude/skills/jarvis/SKILL.md`),
    ],
    entries: [],
    effect_hint: { project: '新开会话后生效', user: '新开会话后生效' },
  },
  {
    client: 'codex',
    label: 'Codex',
    assets: ['rule', 'skill'],
    scopes: ['project', 'user'],
    stability: { rule: 'stable', skill: 'experimental' },
    notes: ['规则写入 AGENTS.md 的托管块；同目录 AGENTS.override.md 可能优先。'],
    detected: { project: true, user: false },
    targets: [
      rawTarget('project', 'rule', `${WORKSPACE}/AGENTS.md`, 'managed_block'),
      rawTarget('project', 'skill', `${WORKSPACE}/.codex/skills/jarvis/SKILL.md`),
    ],
    entries: [],
    effect_hint: { project: '新开会话后生效', user: '新开会话后生效' },
  },
];

const OVERVIEW_200 = { clients: RAW_CLIENTS, self_test: SELF_TEST_RAW };

const OVERVIEW_500 = {
  error: {
    code: 'SCHEMA_MISMATCH',
    message: '本地数据库缺少表「client_entries」，请重启本地服务',
    detail: 'SqliteFailure: (1, "no such table: main.client_entries")',
  },
};

/* ------------------------------------------------------------------ ClientCard 形状 */

const NOOP_CARD_PROPS = {
  onPreview: () => {},
  onVerify: () => {},
  onUninstall: () => {},
  onSelfTest: () => {},
  onCopyRule: () => {},
};

/** 直接构造类型化检测结果（卡片能力边界不需要走网络）。 */
function detectResult(
  overrides: Partial<ClientDetectResult> & Pick<ClientDetectResult, 'client' | 'label'>,
): ClientDetectResult {
  return {
    assets: ['rule', 'skill'],
    scopes: ['project', 'user'],
    stability: { rule: 'stable', skill: 'stable' },
    notes: [],
    detected: { project: false, user: false },
    targets: [],
    entries: [],
    effectHint: { project: '', user: '' },
    ...overrides,
  };
}

const QODER_DETECTED = detectResult({
  client: 'qoder',
  label: 'Qoder',
  detected: { project: true, user: true },
});

/* ------------------------------------------------------------------ PlanDialog 构造 */

function planAction(
  overrides: Partial<ClientEntryPlanAction> & Pick<ClientEntryPlanAction, 'assetType' | 'targetPath' | 'action'>,
): ClientEntryPlanAction {
  return {
    assetName: 'jarvis',
    writeMode: 'file',
    content: 'jarvis 入口内容',
    contentChars: 100,
    contentHash: 'content-hash',
    expectedPrevHash: null,
    backupRequired: false,
    warnings: [],
    ...overrides,
  };
}

const CONFLICT_PLAN: ClientEntryPlan = {
  client: 'qoder',
  scope: 'project',
  planHash: 'plan-conflict-001',
  actions: [
    planAction({
      assetType: 'rule',
      targetPath: `${WORKSPACE}/AGENTS.md`,
      writeMode: 'managed_block',
      action: 'conflict',
      reason: '目标文件已有非本应用内容',
      content: '# 规则正文（预览）',
      contentChars: 1234,
      warnings: ['目标文件含未闭合的托管块'],
    }),
    planAction({
      assetType: 'skill',
      targetPath: `${WORKSPACE}/.qoder/skills/jarvis/SKILL.md`,
      action: 'create',
      content: '# 贾维斯操作技能',
      contentChars: 88,
    }),
  ],
  warnings: ['项目内已有 AGENTS.md，将写入托管块后再校验'],
};

/* ================================================================== 1. ClientEntryTab 三态 */

describe('ClientEntryTab：列表三态（骨架 / 错误面 / 空态）', () => {
  it('还没读到概览 → 骨架，不摆空态或客户端卡片', () => {
    stubFetch({ '/client-entries': { status: 500, body: OVERVIEW_500 } });
    const html = renderNode(
      newClient(),
      createElement(ClientEntryTab, { initialWorkspace: WORKSPACE }),
    );
    expect(html).toContain('animate-shimmer');
    expect(html).not.toContain('没有可用的客户端适配器');
    expect(html).not.toContain('Qoder');
    expect(html).not.toContain('本地数据库缺少表');
  });

  it('GET /client-entries 500（SCHEMA_MISMATCH）→ 错误面替掉空态与卡片', async () => {
    stubFetch({ '/client-entries': { status: 500, body: OVERVIEW_500 } });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.clientEntries(WORKSPACE),
      queryFn: () => api.clientEntries.detect(WORKSPACE),
    });

    const html = renderNode(client, createElement(ClientEntryTab, { initialWorkspace: WORKSPACE }));
    expect(html).toContain('本地数据库缺少表「client_entries」，请重启本地服务');
    expect(html).toContain('详情');
    expect(html).not.toContain('没有可用的客户端适配器');
    expect(html).not.toContain('Qoder');
    expect(html).not.toContain('animate-shimmer');
  });

  it('GET /client-entries 200 且真的零个客户端 → 空态', async () => {
    stubFetch({
      '/client-entries': { status: 200, body: { clients: [], self_test: SELF_TEST_RAW } },
    });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.clientEntries(WORKSPACE),
      queryFn: () => api.clientEntries.detect(WORKSPACE),
    });

    const html = renderNode(client, createElement(ClientEntryTab, { initialWorkspace: WORKSPACE }));
    expect(html).toContain('没有可用的客户端适配器');
    expect(html).not.toContain('animate-shimmer');
  });

  it('200 + 六端 snake_case fixture → 六个客户端、路径、资产行与检测/实验徽章', async () => {
    stubFetch({ '/client-entries': { status: 200, body: OVERVIEW_200 } });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.clientEntries(WORKSPACE),
      queryFn: () => api.clientEntries.detect(WORKSPACE),
    });

    const html = renderNode(client, createElement(ClientEntryTab, { initialWorkspace: WORKSPACE }));

    for (const label of ['Qoder', 'Cursor', 'Cline', 'Windsurf', 'Claude Code', 'Codex']) {
      expect(html, `应渲染 ${label} 卡片`).toContain(label);
    }
    for (const path of [
      `${WORKSPACE}/.qoder/rules/jarvis.md`,
      `${WORKSPACE}/.cursor/rules/jarvis.mdc`,
      `${WORKSPACE}/.clinerules/jarvis.md`,
      `${WORKSPACE}/.windsurf/rules/jarvis.md`,
      `${WORKSPACE}/CLAUDE.md`,
      `${WORKSPACE}/AGENTS.md`,
    ]) {
      expect(html, `应渲染目标路径 ${path}`).toContain(path);
    }

    expect(html).toContain('入口规则');
    expect(html).toContain('操作技能');
    expect(html).toContain('预览安装');
    // Cursor / Codex 的 skill 是 experimental → 至少一个「实验」徽章。
    expect(html).toContain('实验');
    // 一个 detected.project=true、一个 false（Cursor），两种检测文案都要出现。
    expect(html).toMatch(/>检测到项目级配置目录<\/p>/);
    expect(html).toContain('未检测到项目级配置目录（仍可安装）');
    // 台账行与自测摘要也经过 resource 层映射（snake_case → camelCase）。
    expect(html).toContain('已安装');
    expect(html).toContain('可更新');
    expect(html).toContain('jarvis-workbench');
    expect(html).toContain('http://127.0.0.1:7788/mcp');
  });
});

/* ================================================================== 2. ClientCard 能力边界 */

describe('ClientCard：作用域与资产能力边界', () => {
  it('无 workspace 且只有项目级（Cursor）→ 提示先选目录，预览安装禁用', () => {
    const cursor = detectResult({
      client: 'cursor',
      label: 'Cursor',
      scopes: ['project'],
      detected: { project: false, user: false },
      targets: [
        {
          scope: 'project',
          asset: 'rule',
          path: `${WORKSPACE}/.cursor/rules/jarvis.mdc`,
          writeMode: 'file',
          confidence: 'confirmed',
          exists: false,
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(ClientCard, {
        client: cursor,
        workspace: '',
        ...NOOP_CARD_PROPS,
      }),
    );

    expect(html).toContain('需要先选择项目目录');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>预览安装<\/button>/);
  });

  it('Cline / Windsurf 形状（assets 只有 rule）→ 不渲染「操作技能」', () => {
    for (const [id, label] of [
      ['cline', 'Cline'],
      ['windsurf', 'Windsurf'],
    ] as const) {
      const card = detectResult({
        client: id,
        label,
        assets: ['rule'],
        stability: { rule: 'stable', skill: 'experimental' },
        targets: [
          {
            scope: 'project',
            asset: 'rule',
            path: `${WORKSPACE}/.${id}/rules/jarvis.md`,
            writeMode: 'file',
            confidence: 'confirmed',
            exists: false,
          },
        ],
      });

      const html = renderToStaticMarkup(
        createElement(ClientCard, {
          client: card,
          workspace: WORKSPACE,
          ...NOOP_CARD_PROPS,
        }),
      );

      expect(html, `${label} 应显示入口规则`).toContain('入口规则');
      expect(html, `${label} 不应显示操作技能`).not.toContain('操作技能');
    }
  });
});

/* ================================================================== 3. PlanDialog */

describe('PlanDialog：只展示服务端计划，冲突与超限禁用确认', () => {
  it('冲突 + 新建：显示冲突说明、路径、字数、内容预览与警告，确认安装禁用', () => {
    const html = renderToStaticMarkup(
      createElement(PlanDialog, {
        open: true,
        clientLabel: 'Qoder',
        plan: CONFLICT_PLAN,
        installing: false,
        error: null,
        onClose: () => {},
        onConfirm: () => {},
        onReplan: () => {},
        onCopy: () => {},
      }),
    );

    expect(html).toContain('冲突');
    expect(html).toContain('该位置已有非本应用内容，未覆盖');
    expect(html).toContain(`${WORKSPACE}/AGENTS.md`);
    expect(html).toContain('1234 字');
    expect(html).toContain('# 规则正文（预览）');
    expect(html).toContain('# 贾维斯操作技能');
    expect(html).toContain('目标文件含未闭合的托管块');
    expect(html).toContain('项目内已有 AGENTS.md，将写入托管块后再校验');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认安装<\/button>/);
  });

  it('无冲突时确认安装不带 disabled', () => {
    const plan: ClientEntryPlan = {
      client: 'qoder',
      scope: 'project',
      planHash: 'plan-clean-001',
      actions: [
        planAction({
          assetType: 'rule',
          targetPath: `${WORKSPACE}/AGENTS.md`,
          action: 'create',
          contentChars: 88,
        }),
      ],
      warnings: [],
    };

    const html = renderToStaticMarkup(
      createElement(PlanDialog, {
        open: true,
        clientLabel: 'Qoder',
        plan,
        installing: false,
        error: null,
        onClose: () => {},
        onConfirm: () => {},
        onReplan: () => {},
        onCopy: () => {},
      }),
    );

    expect(html).toContain('新建');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>确认安装<\/button>/);
    const confirmTag = /<button[^>]*>确认安装<\/button>/.exec(html)?.[0] ?? '';
    expect(confirmTag).toContain('确认安装');
    // 注意 class 里本来就有 `disabled:*` 变体，这里只认真正的 disabled 属性。
    expect(confirmTag).not.toMatch(/\sdisabled=""/);
  });

  it('limitChars 超过 charLimit → 出现豁免复选框（按整份文件字数），未勾选前确认仍禁用', () => {
    // contentChars 很小、limitChars 超限：托管块外的用户内容撑大了整份文件，必须只看 limitChars。
    const plan: ClientEntryPlan = {
      client: 'windsurf',
      scope: 'user',
      planHash: 'plan-over-limit-001',
      actions: [
        planAction({
          assetType: 'rule',
          targetPath: `${WORKSPACE}/.codeium/windsurf/memories/global_rules.md`,
          writeMode: 'managed_block',
          action: 'create',
          contentChars: 200,
          charLimit: 6000,
          limitChars: 6100,
        }),
      ],
      warnings: [],
    };

    const html = renderToStaticMarkup(
      createElement(PlanDialog, {
        open: true,
        clientLabel: 'Windsurf',
        plan,
        installing: false,
        error: null,
        onClose: () => {},
        onConfirm: () => {},
        onReplan: () => {},
        onCopy: () => {},
      }),
    );

    expect(html).toContain('200 字');
    // 块正文与整份文件长度不同时，单独标出写入后的整文件字数。
    expect(html).toContain('写入后 6100 字');
    expect(html).toContain('写入后 6100 字超过客户端上限（6000 字），仍要写入');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认安装<\/button>/);
  });

  it('limitChars 未超过 charLimit → 不出现豁免复选框，确认可点', () => {
    const plan: ClientEntryPlan = {
      client: 'windsurf',
      scope: 'user',
      planHash: 'plan-under-limit-001',
      actions: [
        planAction({
          assetType: 'rule',
          targetPath: `${WORKSPACE}/.codeium/windsurf/memories/global_rules.md`,
          writeMode: 'managed_block',
          action: 'create',
          contentChars: 200,
          charLimit: 6000,
          limitChars: 5900,
        }),
      ],
      warnings: [],
    };

    const html = renderToStaticMarkup(
      createElement(PlanDialog, {
        open: true,
        clientLabel: 'Windsurf',
        plan,
        installing: false,
        error: null,
        onClose: () => {},
        onConfirm: () => {},
        onReplan: () => {},
        onCopy: () => {},
      }),
    );

    expect(html).toContain('写入后 5900 字');
    expect(html).not.toContain('仍要写入');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>确认安装<\/button>/);
  });
});

/* ================================================================== 4. SelfTestDialog */

describe('SelfTestDialog：自检来源与轮询结果', () => {
  it('三条 probe（无来源 / 当前客户端 / 其他客户端）分别给出正确来源文案', async () => {
    stubFetch({
      [SELF_TEST_PATH]: {
        status: 200,
        body: {
          server_name: 'jarvis-workbench',
          mcp_endpoint: 'http://127.0.0.1:7788/mcp',
          wake_mode: 'continuous',
          probes: [
            { id: 'p-null', source: null, token_name: null, received_at: '2026-10-23T09:00:00.000Z' },
            { id: 'p-qoder', source: 'qoder', token_name: 'local-ui', received_at: '2026-10-23T09:00:03.000Z' },
            { id: 'p-cursor', source: 'cursor', token_name: null, received_at: '2026-10-23T09:00:06.000Z' },
          ],
        },
      },
    });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.clientEntrySelfTest(),
      queryFn: () => api.clientEntries.selfTest(),
    });

    const html = renderNode(
      client,
      createElement(SelfTestDialog, {
        open: true,
        client: QODER_DETECTED,
        onClose: () => {},
      }),
    );

    expect(html).toContain('收到自检（未标注客户端）');
    expect(html).toContain('来自 Qoder（已自测）');
    expect(html).toContain('来自 cursor');
    expect(html).toContain('http://127.0.0.1:7788/mcp');
    expect(html).toContain('当前模式：连续');
  });

  it('probes 为空 → 空态「还没有收到自检」', async () => {
    stubFetch({
      [SELF_TEST_PATH]: {
        status: 200,
        body: {
          server_name: 'jarvis-workbench',
          mcp_endpoint: 'http://127.0.0.1:7788/mcp',
          wake_mode: 'single',
          probes: [],
        },
      },
    });
    const client = newClient();
    await client.prefetchQuery({
      queryKey: qk.clientEntrySelfTest(),
      queryFn: () => api.clientEntries.selfTest(),
    });

    const html = renderNode(
      client,
      createElement(SelfTestDialog, {
        open: true,
        client: QODER_DETECTED,
        onClose: () => {},
      }),
    );

    expect(html).toContain('还没有收到自检');
    expect(html).not.toContain('收到自检（未标注客户端）');
  });
});

/* ================================================================== 5. API 资源层契约 */

describe('api.clientEntries：请求体契约与 snake_case → camelCase 映射', () => {
  it('install 请求体带 plan_hash / confirm / allow_over_limit，且用户级不带 workspace', async () => {
    const calls = captureFetch({ entries: [], actions: [] });

    await api.clientEntries.install({
      client: 'windsurf',
      scope: 'user',
      planHash: 'abc123',
      confirm: true,
      allowOverLimit: true,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/v1/client-entries/install');
    expect(calls[0]?.method).toBe('POST');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.client).toBe('windsurf');
    expect(body.scope).toBe('user');
    expect(body.plan_hash).toBe('abc123');
    expect(body.confirm).toBe(true);
    expect(body.allow_over_limit).toBe(true);
    expect(body).not.toHaveProperty('workspace');
  });

  it('plan 请求体 trim workspace、原样带 assets，且不含 plan_hash', async () => {
    const calls = captureFetch({
      client: 'qoder',
      scope: 'project',
      plan_hash: 'plan-1',
      actions: [],
      warnings: [],
    });

    await api.clientEntries.plan({
      client: 'qoder',
      scope: 'project',
      workspace: ' /tmp/ws ',
      assets: ['rule'],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/v1/client-entries/plan');
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.client).toBe('qoder');
    expect(body.scope).toBe('project');
    expect(body.workspace).toBe('/tmp/ws');
    expect(body.assets).toEqual(['rule']);
    expect(body).not.toHaveProperty('plan_hash');
    expect(body).not.toHaveProperty('confirm');
  });

  it('plan 回包：plan_hash / content_chars / target_path 映射为 camelCase', async () => {
    captureFetch({
      client: 'qoder',
      scope: 'project',
      plan_hash: 'hash-abc',
      actions: [
        {
          asset_type: 'rule',
          asset_name: 'jarvis',
          target_path: `${WORKSPACE}/AGENTS.md`,
          write_mode: 'managed_block',
          action: 'create',
          content: '规则正文',
          content_chars: 1234,
          content_hash: 'content-hash',
          expected_prev_hash: null,
          backup_required: false,
          warnings: [],
          char_limit: 6000,
          limit_chars: 6100,
        },
      ],
      warnings: [],
    });

    const plan = await api.clientEntries.plan({
      client: 'qoder',
      scope: 'project',
      workspace: WORKSPACE,
    });

    expect(plan.planHash).toBe('hash-abc');
    expect(plan.actions[0]?.contentChars).toBe(1234);
    expect(plan.actions[0]?.targetPath).toBe(`${WORKSPACE}/AGENTS.md`);
    expect(plan.actions[0]?.charLimit).toBe(6000);
    // 写入后整份文件的字符数（含块外用户内容）单独映射，不与 contentChars 混用。
    expect(plan.actions[0]?.limitChars).toBe(6100);
  });

  it('install 回包：台账行与动作同样映射为 camelCase', async () => {
    captureFetch({
      entries: [
        {
          id: 'entry-1',
          client: 'windsurf',
          scope: 'user',
          workspace_path: null,
          asset_type: 'rule',
          asset_name: 'jarvis',
          target_path: '/home/user/.codeium/windsurf/memories/global_rules.md',
          write_mode: 'file',
          status: 'installed',
          template_version: 1,
          installed_at: '2026-10-23T09:00:00.000Z',
          verified_at: null,
          last_error: null,
          update_available: false,
        },
      ],
      actions: [
        {
          asset_type: 'rule',
          asset_name: 'jarvis',
          target_path: '/home/user/.codeium/windsurf/memories/global_rules.md',
          write_mode: 'file',
          action: 'create',
          content: '规则正文',
          content_chars: 4,
          content_hash: 'content-hash',
          expected_prev_hash: null,
          backup_required: false,
          warnings: [],
        },
      ],
    });

    const result = await api.clientEntries.install({
      client: 'windsurf',
      scope: 'user',
      planHash: 'abc123',
      confirm: true,
    });

    expect(result.entries[0]?.targetPath).toBe(
      '/home/user/.codeium/windsurf/memories/global_rules.md',
    );
    expect(result.entries[0]?.assetType).toBe('rule');
    expect(result.actions[0]?.contentChars).toBe(4);
    expect(result.actions[0]?.targetPath).toBe(
      '/home/user/.codeium/windsurf/memories/global_rules.md',
    );
  });

  it('uninstall 回包：kept=unmanaged（安装前已存在的接管文件）不被当成未知值丢掉', async () => {
    captureFetch({ removed: true, kept: 'unmanaged' });

    const result = await api.clientEntries.uninstall('ce-qoder-rule');

    expect(result.removed).toBe(true);
    expect(result.kept).toBe('unmanaged');
  });
});

/* ================================================================== 6. 轮询配置源码闸 */

describe('useClientEntrySelfTest：轮询只在弹窗打开时开启', () => {
  it('refetchInterval 与 enabled 都受 open 控制，防止改成常开轮询', () => {
    const file = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../client-entry/client-entry-queries.ts',
    );
    const source = readFileSync(file, 'utf8');
    expect(source).toMatch(/refetchInterval:\s*open\s*\?\s*3000\s*:\s*false/);
    expect(source).toMatch(/enabled:\s*open/);
  });
});
