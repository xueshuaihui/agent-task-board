import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BreakdownSession } from '@/api/types';
import {
  filterLoadedSessions,
  HISTORY_SEARCH_PLACEHOLDER,
  historySearchHint,
} from '../history';

/**
 * #4.3 方案 B 的路由/页面/历史闸（web 无 jsdom，源码扫描 + 导出真值直测）。
 *
 * 钉四块：
 * 1. `breakdown` 是 `ROUTES` 里的二级路由，但**不进** `NAV_ORDER`；
 * 2. 壳层 PAGES、侧栏图标/高亮、需求页两个入口都接上了二级页面；
 * 3. 页面 URL 状态：`?session=` 驱动当前会话、切换写回并保留 `?requirement=`、
 *    无 session 回落第一条进行中；历史段 cursor 分页 + 已加载搜索 + 归档开关；
 * 4. `breakdown.revision_requested` 进 WS 失效表，类型字段与 API 查询参数齐备。
 */

const WEB_SRC = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(WEB_SRC, path), 'utf8');

// router 模块装配期读一次 hash——与 groups/filter-prefs 的源码闸同法：
// 先 stub 最小 window，再动态 import，按导出真值断言。
vi.stubGlobal('window', {
  location: { hash: '' },
  history: { replaceState: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
});
const { ROUTES, NAV_ORDER } = await import('@/app/router');
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('路由常量：#4.3 方案 B 的二级路由与主导航边界', () => {
  it('ROUTES 增加 breakdown（/requirements/breakdown，label 拆解）', () => {
    expect(ROUTES.breakdown).toEqual({ path: '/requirements/breakdown', label: '拆解' });
  });

  it('NAV_ORDER 仍是五条且不含 breakdown（左侧主导航不出现「拆解」）', () => {
    expect([...NAV_ORDER]).toEqual(['board', 'requirements', 'skills', 'review', 'settings']);
    expect(NAV_ORDER).not.toContain('breakdown');
  });
});

describe('壳层接线：PAGES / 侧栏 / 需求页两个入口', () => {
  const app = read('app/app.tsx');
  const sidebar = read('app/sidebar.tsx');
  const requirementsPage = read('features/requirements/requirements-page.tsx');

  it('PAGES 挂 BreakdownPage，且从 feature barrel 导入', () => {
    expect(app).toContain("import { BreakdownPage } from '@/features/breakdown'");
    expect(app).toContain('breakdown: BreakdownPage');
  });

  it('侧栏补 Record 图标，并在 breakdown 路由下保持「需求」高亮', () => {
    expect(sidebar).toContain('breakdown: ListTree');
    expect(sidebar).toContain("name === 'requirements' && route.name === 'breakdown'");
  });

  it('需求页 header「拆解记录」进二级页面（不带 requirement）', () => {
    expect(requirementsPage).toContain('拆解记录');
    expect(requirementsPage).toContain("navigate('breakdown')");
    expect(requirementsPage).toContain('requirements-breakdown-history');
  });

  it('需求菜单「拆解历史」带 requirement 过滤；#8 的 has_execution_rules 徽标仍在', () => {
    expect(requirementsPage).toContain('拆解历史');
    expect(requirementsPage).toContain(
      "navigate('breakdown', `?requirement=${encodeURIComponent(task.id)}`)",
    );
    expect(requirementsPage).toContain('task.has_execution_rules');
    expect(requirementsPage).toContain('有执行规则');
  });
});

describe('二级页面：URL 驱动、进行中/历史分段与只读口径', () => {
  const page = read('features/breakdown/breakdown-page.tsx');

  it('当前会话读 ?session、筛选读 ?requirement；切换写回两者', () => {
    expect(page).toContain("route.search.get('session')");
    expect(page).toContain("route.search.get('requirement')");
    expect(page).toContain("params.set('session', id)");
    expect(page).toContain("params.set('requirement', requirementId)");
    expect(page).toContain("navigate('breakdown', `?${params.toString()}`)");
  });

  it('无 session 时回落到第一条进行中会话；进行中走 scope=active', () => {
    expect(page).toContain('activeSessions[0]?.id');
    expect(page).toContain("scope: 'active'");
    expect(page).toContain('requirement_id: requirementId');
  });

  it('需求入口默认落在历史段；带 session 深链首次按归属纠正段位', () => {
    expect(page).toContain(
      "useState<'active' | 'history'>(requirementId ? 'history' : 'active')",
    );
    expect(page).toContain('autoTabApplied');
    expect(page).toContain(
      "setTab(activeSessions.some((session) => session.id === sessionParam) ? 'active' : 'history')",
    );
  });

  it('历史段：scope=history、include_archived 开关、cursor 加载更多、已加载搜索', () => {
    expect(page).toContain('useBreakdownHistory');
    expect(page).toContain("scope: 'history'");
    expect(page).toContain('include_archived: includeArchived');
    expect(page).toContain('包含已归档需求');
    expect(page).toContain('filterLoadedSessions');
    expect(page).toContain('HISTORY_SEARCH_PLACEHOLDER');
    expect(page).toContain('加载更多');
    expect(page).toContain('breakdown-history-load-more');
  });

  it('历史列表展示状态/父需求归档/标题/时间/Agent/草案数', () => {
    expect(page).toContain('<BreakdownStatusBadge');
    expect(page).toContain('父需求已归档');
    expect(page).toContain('session.parent_title');
    expect(page).toContain('formatDateTime(time)');
    expect(page).toContain("session.agent_name ?? '—'");
    expect(page).toContain("session.actual_tasks ?? '—'");
  });

  it('返回需求页并带回 requirement；历史详情复用同一 Workspace（终态无写动作）', () => {
    expect(page).toContain("navigate(\n      'requirements'");
    expect(page).toContain('?requirement=${encodeURIComponent(requirementId)}');
    expect(page).toContain('<BreakdownWorkspace');
    expect(page).toContain('历史会话只读');
  });
});

describe('数据层：cursor 分页、重生成失效与 WS 六条', () => {
  const queries = read('features/breakdown/queries.ts');
  const invalidate = read('ws/invalidate.ts');
  const types = read('api/types.ts');

  it('历史用 useInfiniteQuery，cursor=上一页最后一条 id', () => {
    expect(queries).toContain('useInfiniteQuery');
    expect(queries).toContain('cursor: pageParam');
    expect(queries).toContain('lastPage[lastPage.length - 1]?.id');
  });

  it('两个重生成 mutation 都失效 qk.breakdownRoot', () => {
    expect(queries).toContain('useBreakdownRegenerateDraft');
    expect(queries).toContain('useBreakdownRegenerateSession');
    const rootInvalidations = queries.match(/invalidate: \[qk\.breakdownRoot\]/g) ?? [];
    expect(rootInvalidations.length).toBeGreaterThanOrEqual(2);
  });

  it('WS 失效表接上 breakdown.revision_requested，breakdown 共六条', () => {
    expect(invalidate).toContain("case 'breakdown.revision_requested':");
    const cases = invalidate.match(/case 'breakdown\./g) ?? [];
    expect(cases.length).toBe(6);
    expect(invalidate).toContain('breakdown.* 六条');
  });

  it('类型补 revision/note/请求时刻/父需求归档与列表查询', () => {
    for (const field of [
      'revision: number;',
      'revision_note: string | null;',
      'revision_requested_at: string | null;',
      'parent_archived_at: string | null;',
      'regeneration_note?: string | null;',
      'regeneration_requested_at?: string | null;',
    ]) {
      expect(types).toContain(field);
    }
    expect(types).toContain('export interface BreakdownListQuery');
    expect(types).toContain("'breakdown.revision_requested': {");
  });
});

describe('filterLoadedSessions：只过滤已加载记录，占位文案不冒充全库搜索', () => {
  const make = (patch: Partial<BreakdownSession>): BreakdownSession => ({
    id: 's-0',
    requirement_text: '',
    group_id: null,
    parent_title: '',
    parent_description: null,
    parent_task_id: null,
    status: 'completed',
    agent_name: null,
    skill_used: null,
    estimated_tasks: null,
    actual_tasks: null,
    revision: 0,
    revision_note: null,
    revision_requested_at: null,
    parent_archived_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    finished_at: null,
    confirmed_at: null,
    cancelled_at: null,
    ...patch,
  });
  const sessions = [
    make({
      id: 's-1',
      parent_title: '登录改造',
      requirement_text: '支持微信登录',
      agent_name: 'Alpha',
    }),
    make({
      id: 's-2',
      parent_title: '支付拆分',
      requirement_text: '退款流程',
      agent_name: 'beta',
    }),
    make({
      id: 's-3',
      parent_title: '登录审计',
      requirement_text: '记录登录',
      agent_name: null,
    }),
  ];
  const ids = (rows: BreakdownSession[]) => rows.map((row) => row.id);

  it('标题 / 需求原文 / Agent 三列都参与，大小写不敏感', () => {
    expect(ids(filterLoadedSessions(sessions, '登录'))).toEqual(['s-1', 's-3']);
    expect(ids(filterLoadedSessions(sessions, '微信'))).toEqual(['s-1']);
    expect(ids(filterLoadedSessions(sessions, 'ALPHA'))).toEqual(['s-1']);
    expect(ids(filterLoadedSessions(sessions, '退款'))).toEqual(['s-2']);
    expect(filterLoadedSessions(sessions, '不存在的词')).toEqual([]);
  });

  it('空关键词返回全部（副本），不改变原数组', () => {
    const all = filterLoadedSessions(sessions, '   ');
    expect(ids(all)).toEqual(['s-1', 's-2', 's-3']);
    expect(all).not.toBe(sessions);
  });

  it('占位与提示都写明「当前已加载」，不误导为服务端搜索', () => {
    expect(HISTORY_SEARCH_PLACEHOLDER).toContain('当前已加载');
    expect(historySearchHint(12)).toBe('仅过滤已加载的 12 条记录，不是全库搜索');
  });
});
