import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { boardFilterSearch, filtersFromSearch } from '@/app/store/filters';
import {
  BOARD_FILTER_LOCAL_KEY,
  DEFAULT_BOARD_FILTER_PREFS,
  GROUPING_LOCAL_KEY,
  mergeGroupingPrefs,
  migrateV1Slots,
  normalizeBoardFilterPrefs,
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

// `filter-url-sync` 经 `@/app/router` 进模块图——router 装配期读一次 hash。
// 与 `column-always-open.test.ts` 同法：先 stub 最小 window，再顶层 await 动态 import。
vi.stubGlobal('window', {
  location: { hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const { stripLegacyGroupsParam } = await import('../filter-url-sync');
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('B15-② 偏好迁移 → v2 扁平（§19.14：groups 读取时丢弃、不回写）', () => {
  it('v1 槽形状 → 对应维数组，值词表翻译（__unassigned__→none、tag:x→x），并回写 v2', async () => {
    const { read, localStorage } = await load({
      [BOARD_FILTER_LOCAL_KEY]: JSON.stringify({
        slotA: { dim: 'requirement', values: ['r-1', '__unassigned__', 'r-1'] },
        slotB: { dim: 'tag', values: ['tag:urgent', '__unassigned__'] },
      }),
    });
    expect(read()).toMatchObject({ requirements: ['r-1', 'none'], tags: ['urgent'] });
    const written = JSON.parse(localStorage.store.get(BOARD_FILTER_LOCAL_KEY) ?? '{}') as Record<string, unknown>;
    expect(written.requirements).toEqual(['r-1', 'none']);
    expect(written).not.toHaveProperty('groups');
    expect(written.slotA).toBeUndefined();
  });

  it('v1 槽 dim==="group" 的历史值读取即丢弃，不进偏好、不回写', async () => {
    const { read, localStorage } = await load({
      [BOARD_FILTER_LOCAL_KEY]: JSON.stringify({
        slotA: { dim: 'group', values: ['g-1', '__unassigned__'] },
        slotB: { dim: 'tag', values: ['tag:urgent'] },
      }),
    });
    expect(read()).toMatchObject({ tags: ['urgent'] });
    expect(read()).not.toHaveProperty('groups');
    const written = JSON.parse(localStorage.store.get(BOARD_FILTER_LOCAL_KEY) ?? '{}') as Record<string, unknown>;
    expect(written).not.toHaveProperty('groups');
  });

  it('无新键、只有旧 grouping：只读迁移链保留（primary/laneFilter 照常翻译），groupIds 作用域值丢弃', async () => {
    const { read } = await load({
      [GROUPING_LOCAL_KEY]: JSON.stringify({
        groupIds: ['g-1', 42, 'g-1'],
        primary: 'priority',
        laneFilter: ['p1', 'p3', 'bogus'],
      }),
    });
    expect(read()).toMatchObject({ priority: [1, 3] });
    expect(read()).not.toHaveProperty('groups');
  });

  it('status/none 槽不参与迁移（列本身就是状态）', () => {
    const prefs = migrateV1Slots({
      slotA: { dim: 'status', values: ['RUNNING'] },
      slotB: { dim: 'none', values: [] },
    });
    expect(prefs).toEqual(DEFAULT_BOARD_FILTER_PREFS);
  });

  it('已是 v2 → 归一化（旧持久化 groups 值读取时丢弃），grouping 旧键不再合并（防已清空作用域复活）', async () => {
    const { read } = await load({
      [BOARD_FILTER_LOCAL_KEY]: JSON.stringify({ groups: ['g-9'], view: 'review' }),
      [GROUPING_LOCAL_KEY]: JSON.stringify({ groupIds: ['g-1'] }),
    });
    expect(read()).toMatchObject({ view: 'review' });
    expect(read()).not.toHaveProperty('groups');
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

  it('normalize 丢弃历史 groups 键（§19.14：读取时剥离、切片里不再有这一位）', () => {
    const prefs = normalizeBoardFilterPrefs({ groups: ['g-1', 'none'], tags: ['t'] });
    expect(prefs).not.toHaveProperty('groups');
    expect(prefs.tags).toEqual(['t']);
  });

  it('mergeGroupingPrefs：groupIds/projectIds 值一律丢弃（只读迁移链保留）', () => {
    const prefs = { ...DEFAULT_BOARD_FILTER_PREFS, customFields: {} };
    mergeGroupingPrefs(prefs, { projectIds: ['p-1'] });
    mergeGroupingPrefs(prefs, { groupIds: ['g-1'] });
    expect(prefs).toEqual(DEFAULT_BOARD_FILTER_PREFS);
  });

  it('服务端 board.filter 缺失、grouping 在：水合合并进本地迁移值（本地独有维度不被顶掉），groups 两边都丢', async () => {
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
      expect(useFilterStore.getState().priority).toEqual([1]);
    });
    // 看板侧不再把 groups 水合进 store（store 键保留给列表作用域，初值恒空）。
    expect(useFilterStore.getState().groups).toEqual([]);
    const written = JSON.parse(localStorage.store.get(BOARD_FILTER_LOCAL_KEY) ?? '{}') as Record<string, unknown>;
    expect(written.priority).toEqual([1]);
    expect(written).not.toHaveProperty('groups');
  });
});

describe('B15-② URL 查询串 ←→ 过滤态', () => {
  it('boardFilterSearch 恒不产出 groups 键（§19.14：store 残值被剥离），其余维度与逗号值保持往返', () => {
    const withLegacyGroups = {
      view: 'all',
      priority: [1],
      type: ['Bug'],
      tags: [],
      groups: ['g-1', 'none'],
      requirements: [],
      agents: ['atb'],
    } satisfies Parameters<typeof boardFilterSearch>[0] & { groups: string[] };
    const search = boardFilterSearch(withLegacyGroups);
    expect(search).toBe('?priority=1&type=Bug&agents=atb');
    expect(search).not.toContain('groups');
    const patch = filtersFromSearch(new URLSearchParams(search.slice(1)));
    expect(patch).toMatchObject({
      priority: [1],
      type: ['Bug'],
      agents: ['atb'],
    });
    expect(patch?.groups).toBeUndefined();
    expect(patch?.view).toBeUndefined();
  });

  it('看板解析 URL 前剥离 groups=（stripLegacyGroupsParam）；列表路由的 filtersFromSearch 照旧认 groups', () => {
    const search = new URLSearchParams('priority=1&groups=g-1%2Cnone&type=Bug');
    const stripped = stripLegacyGroupsParam(search);
    expect(stripped.has('groups')).toBe(false);
    expect(stripped.get('priority')).toBe('1');
    expect(stripped.get('type')).toBe('Bug');
    const patch = filtersFromSearch(stripped);
    expect(patch?.groups).toBeUndefined();
    // 原 search 不被改动（新对象），且直接喂 filtersFromSearch 仍能得到 groups（列表口径不变）。
    expect(search.has('groups')).toBe(true);
    expect(filtersFromSearch(search)?.groups).toEqual(['g-1', 'none']);
  });

  it('无过滤参数 → boardFilterSearch 给空串', () => {
    expect(
      boardFilterSearch({
        view: 'all',
        priority: [],
        type: [],
        tags: [],
        requirements: [],
        agents: [],
      }),
    ).toBe('');
  });
});
