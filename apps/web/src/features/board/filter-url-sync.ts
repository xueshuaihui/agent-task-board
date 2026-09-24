import { useEffect } from 'react';
import { boardFilterSearch, filtersFromSearch, useFilterStore } from '@/app/store/filters';
import { ROUTES, useRouterStore, useRouteSearchParams } from '@/app/router';

/**
 * B15-②：看板过滤态 ↔ `#/board?...` 的双向同步（可分享、可书签）。
 * 持久化（localStorage + prefs）在 `filter-prefs.ts`，这里只管 URL 一条腿。
 *
 * §19.14（2026-09-24 拍板）：分组维从看板下线——看板 URL 遇到 `groups=` 一律
 * **解析时剥离丢弃**（不水合进 store、经 `boardFilterSearch` 回写时自然消失）；
 * `groups` 的 URL 读写只剩列表路由（task-list 挂载时 `filtersFromSearch`，一字未动）。
 *
 * 回写一律 `history.replaceState` + 直接改路由 store——不产生浏览器历史条目
 * （2.1「窗口内导航不出现前进后退」），也不会把 URL 写入触发 hashchange 自激。
 */

const URL_FILTER_KEYS = [
  'view',
  'priority',
  'type',
  'tags',
  'requirements',
  'agents',
] as const;

/** 看板侧解析前的收窄：URL 上残留的 `groups=`（旧书签/跳转串）剥离丢弃，其余原样。 */
export function stripLegacyGroupsParam(search: URLSearchParams): URLSearchParams {
  if (!search.has('groups')) return search;
  const next = new URLSearchParams(search);
  next.delete('groups');
  return next;
}

function hasBoardFilterParams(search: URLSearchParams): boolean {
  return URL_FILTER_KEYS.some((key) => search.has(key));
}

/** 看板过滤态 → 当前 hash；不在看板页 / 串没变则不动（字符串比对即环检测）。 */
function writeBoardFilterUrl(): void {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith(ROUTES.board.path)) return;
  const next = `${ROUTES.board.path}${boardFilterSearch(useFilterStore.getState())}`;
  if (hash === next) return;
  window.history.replaceState(null, '', `#${next}`);
  useRouterStore.setState({ location: next });
}

/**
 * BoardPage 挂一次：URL 带过滤参数则水合 store（URL 优先于设备偏好），
 * 否则把偏好投影进 URL；此后 store 的任何过滤变更都回写 URL。
 * `groups=` 永远进不了水合（先剥离）；若剥离动作改过 URL，则立刻回写把它洗掉。
 */
export function useBoardFilterUrlSync(): void {
  const search = useRouteSearchParams();
  useEffect(() => {
    const boardSearch = stripLegacyGroupsParam(search);
    if (hasBoardFilterParams(boardSearch)) {
      const patch = filtersFromSearch(boardSearch);
      if (patch) useFilterStore.setState(patch);
      if (boardSearch !== search) writeBoardFilterUrl();
      return;
    }
    writeBoardFilterUrl();
  }, [search]);
  useEffect(() => useFilterStore.subscribe(() => writeBoardFilterUrl()), []);
}
