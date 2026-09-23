import { useEffect } from 'react';
import { boardFilterSearch, filtersFromSearch, useFilterStore } from '@/app/store/filters';
import { ROUTES, useRouterStore, useRouteSearchParams } from '@/app/router';

/**
 * B15-②：看板过滤态 ↔ `#/board?...` 的双向同步（可分享、可书签）。
 * 持久化（localStorage + prefs）在 `filter-prefs.ts`，这里只管 URL 一条腿。
 *
 * 回写一律 `history.replaceState` + 直接改路由 store——不产生浏览器历史条目
 * （2.1「窗口内导航不出现前进后退」），也不会把 URL 写入触发 hashchange 自激。
 */

const URL_FILTER_KEYS = [
  'view',
  'priority',
  'type',
  'tags',
  'groups',
  'requirements',
  'agents',
] as const;

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
 */
export function useBoardFilterUrlSync(): void {
  const search = useRouteSearchParams();
  useEffect(() => {
    if (hasBoardFilterParams(search)) {
      const patch = filtersFromSearch(search);
      if (patch) useFilterStore.setState(patch);
      return;
    }
    writeBoardFilterUrl();
  }, [search]);
  useEffect(() => useFilterStore.subscribe(() => writeBoardFilterUrl()), []);
}
