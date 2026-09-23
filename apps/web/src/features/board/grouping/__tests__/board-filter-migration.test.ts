import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARD_FILTER_PREFS } from '../filter-model';
import { GROUPING_PREFS_KEY } from '../useGroupingState';
import { BOARD_FILTER_PREFS_KEY } from '../useBoardFilterStore';

/**
 * B13-④ 回归：旧泳道偏好（`atb.board.grouping` 的 primary/secondary/laneFilter）
 * → 过滤槽的一次性迁移。stub 一个最小 `window.localStorage` 后动态 import store，
 * 断言 `readBoardFilterPrefs()` 的翻译结果与回写。
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
  const mod = await import('../useBoardFilterStore');
  return { read: mod.readBoardFilterPrefs, localStorage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('B13-② 偏好迁移 board.grouping → board.filter', () => {
  it('primary=group + laneFilter → slotA 承接维度与值，并回写新键', async () => {
    const { read, localStorage } = await load({
      [GROUPING_PREFS_KEY]: JSON.stringify({
        primary: 'group',
        secondary: 'none',
        laneFilter: ['g-1', 'g-2', 42],
      }),
    });
    expect(read()).toEqual({
      slotA: { dim: 'group', values: ['g-1', 'g-2'] },
      slotB: { dim: 'none', values: [] },
    });
    expect(localStorage.store.get(BOARD_FILTER_PREFS_KEY)).toContain('"slotA"');
  });

  it('secondary 与 primary 撞同一维 → slotB 去重关闭', async () => {
    const { read } = await load({
      [GROUPING_PREFS_KEY]: JSON.stringify({ primary: 'tag', secondary: 'tag', laneFilter: [] }),
    });
    expect(read()).toEqual({
      slotA: { dim: 'tag', values: [] },
      slotB: { dim: 'none', values: [] },
    });
  });

  it('主分组 status/none 本来就是经典视图 → 不迁移', async () => {
    for (const primary of ['status', 'none']) {
      const { read } = await load({
        [GROUPING_PREFS_KEY]: JSON.stringify({ primary, laneFilter: ['x'] }),
      });
      expect(read()).toEqual(DEFAULT_BOARD_FILTER_PREFS);
    }
  });

  it('已有新键时旧键不参与（迁移只发生一次）', async () => {
    const { read } = await load({
      [BOARD_FILTER_PREFS_KEY]: JSON.stringify({ slotA: { dim: 'priority', values: ['p1'] } }),
      [GROUPING_PREFS_KEY]: JSON.stringify({ primary: 'group', laneFilter: ['g-1'] }),
    });
    expect(read()).toEqual({
      slotA: { dim: 'priority', values: ['p1'] },
      slotB: { dim: 'none', values: [] },
    });
  });

  it('旧键坏 JSON / 缺键 → 回落默认不抛错', async () => {
    const broken = await load({ [GROUPING_PREFS_KEY]: '{oops' });
    expect(broken.read()).toEqual(DEFAULT_BOARD_FILTER_PREFS);
    const empty = await load({});
    expect(empty.read()).toEqual(DEFAULT_BOARD_FILTER_PREFS);
  });
});
