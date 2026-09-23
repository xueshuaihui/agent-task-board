import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardFilterSearch, filtersFromSearch } from '@/app/store/filters';
import {
  BOARD_FILTER_LOCAL_KEY,
  DEFAULT_BOARD_FILTER_PREFS,
  GROUPING_LOCAL_KEY,
  mergeGroupingPrefs,
  migrateV1Slots,
  normalizeBoardFilterPrefs,
  type BoardFilterPrefs,
} from '../filter-prefs';

/**
 * B15-②：统一过滤的偏好迁移（v1 槽 / 旧 grouping → v2 扁平）与 URL 序列化往返。
 * stub 一个最小 `window.localStorage` 后动态 import 模块（模块装配会跑一遍本地读取 +
 * 服务端水合，api 失败被 catch 吞掉，不影响断言）。
 */

function makeLocalStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    store,
  };
}

async function load(initial: Record<string, string>) {
  const localStorage = makeLocalStorage(initial);
  vi.resetModules();
  vi.stubGlobal('window', { localStorage });
  const mod = await import('../filter-prefs');
  return { read: mod.readLocalBoardFilterPrefs, localStorage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('B15-② 偏好迁移 → v2 扁平', () => {
  it('v1 槽形状 → 对应维数组，值词表翻译（__unassigned__→none、p2→2、tag:x→x），并回写 v2', async () => {
    const { read, localStorage } = await load({
      [BOARD_FILTER_LOCAL_KEY]: JSON.stringify({
        slotA: { dim: 'group', values: ['g-1', '__unassigned__', 'g-1'] },
        slotB: { dim: 'tag', values: ['tag:urgent', '__unassigned__'] },
      }),
    });
    expect(read()).toMatchObject({ groups: ['g-1', 'none'], tags: ['urgent'] });
    const written = JSON.parse(localStorage.store.get(BOARD_FILTER_LOCAL_KEY) ?? '{}') as Partial<
      BoardFilterPrefs & { slotA?: unknown }
    >;
    expect(written.groups).toEqual(['g-1', 'none']);
    expect(written.slotA).toBeUndefined();
  });

  it('无新键、只有旧 grouping：groupIds + 泳道时代 primary/laneFilter 一并翻译', async () => {
    const { read } = await load({
      [GROUPING_LOCAL_KEY]: JSON.stringify({
        groupIds: ['g-1', 42, 'g-1'],
        primary: 'priority',
        laneFilter: ['p1', 'p3', 'bogus'],
      }),
    });
    expect(read()).toMatchObject({ groups: ['g-1'], priority: [1, 3] });
  });

  it('status/none 槽不参与迁移（列本身就是状态）', () => {
    const prefs = migrateV1Slots({
      slotA: { dim: 'status', values: ['RUNNING'] },
      slotB: { dim: 'none', values: [] },
    });
    expect(prefs).toEqual(DEFAULT_BOARD_FILTER_PREFS);
  });

  it('已是 v2 → 原样归一化，grouping 旧键不再合并（防止已清空的旧作用域复活）', async () => {
    const { read } = await load({
      [BOARD_FILTER_LOCAL_KEY]: JSON.stringify({ groups: ['g-9'], view: 'review' }),
      [GROUPING_LOCAL_KEY]: JSON.stringify({ groupIds: ['g-1'] }),
    });
    expect(read()).toMatchObject({ groups: ['g-9'], view: 'review' });
  });

  it('坏 JSON / 全空 → 回落默认不抛错', async () => {
    const broken = await load({ [GROUPING_LOCAL_KEY]: '{oops' });
    expect(broken.read()).toEqual(DEFAULT_BOARD_FILTER_PREFS);
    const empty = await load({});
    expect(empty.read()).toEqual(DEFAULT_BOARD_FILTER_PREFS);
  });

  it('normalize 拒绝脏值：view 词表外→all、priority 越界丢弃、customFields 只留非空字符串数组', () => {
    const prefs = normalizeBoardFilterPrefs({
      view: 'nonsense',
      priority: [0, 9, 2.5, '1'],
      customFields: { stage: ['dev'], empty: [], bad: 'x' },
    });
    expect(prefs.view).toBe('all');
    expect(prefs.priority).toEqual([0]);
    expect(prefs.customFields).toEqual({ stage: ['dev'] });
  });

  it('mergeGroupingPrefs 兼容 W1 前的 projectIds 键', () => {
    const prefs = { ...DEFAULT_BOARD_FILTER_PREFS, customFields: {} };
    mergeGroupingPrefs(prefs, { projectIds: ['p-1'] });
    expect(prefs.groups).toEqual(['p-1']);
  });

  it('服务端 board.filter 缺失、grouping 在：水合**合并进**本地迁移值，不整份顶掉本地维度', async () => {
    const localStorage = makeLocalStorage({
      [BOARD_FILTER_LOCAL_KEY]: JSON.stringify({
        slotA: { dim: 'group', values: ['g-1'] },
        slotB: { dim: 'priority', values: ['p1'] },
      }),
    });
    vi.resetModules();
    vi.stubGlobal('window', { localStorage });
    vi.doMock('@/api', () => ({
      api: {
        prefs: {
          get: async (key: string) =>
            key === 'board.grouping' ? { value: { groupIds: ['g-2'] } } : { value: null },
          put: async () => undefined,
        },
      },
    }));
    await import('../filter-prefs');
    const { useFilterStore } = await import('@/app/store/filters');
    await vi.waitFor(() => {
      expect(useFilterStore.getState().groups).toEqual(['g-1', 'g-2']);
    });
    expect(useFilterStore.getState().priority).toEqual([1]);
    const written = JSON.parse(localStorage.store.get(BOARD_FILTER_LOCAL_KEY) ?? '{}') as BoardFilterPrefs;
    expect(written.priority).toEqual([1]);
    expect(written.groups).toEqual(['g-1', 'g-2']);
  });
});

describe('B15-② URL 查询串 ←→ 过滤态', () => {
  it('boardFilterSearch → filtersFromSearch 往返保持三维与逗号值', () => {
    const search = boardFilterSearch({
      view: 'all',
      priority: [1],
      type: ['Bug'],
      tags: [],
      groups: ['g-1', 'none'],
      requirements: [],
      agents: ['atb'],
    });
    expect(search).toBe('?priority=1&type=Bug&groups=g-1%2Cnone&agents=atb');
    const patch = filtersFromSearch(new URLSearchParams(search.slice(1)));
    expect(patch).toMatchObject({
      priority: [1],
      type: ['Bug'],
      groups: ['g-1', 'none'],
      agents: ['atb'],
    });
    expect(patch?.view).toBeUndefined();
  });

  it('无过滤参数 → boardFilterSearch 给空串', () => {
    expect(
      boardFilterSearch({
        view: 'all',
        priority: [],
        type: [],
        tags: [],
        groups: [],
        requirements: [],
        agents: [],
      }),
    ).toBe('');
  });
});
