import { useCallback, useMemo } from 'react';
import { navigate, useRouteSearchParams } from '@/app/router';

/**
 * 8.5 的八个 Tab（顺序即 PRD 表格顺序，也是原型 7.1 侧边栏自上而下的顺序）。
 *
 * Tab 值写进 hash（`#/settings?tab=tokens`）而不是只放组件 state：
 * 2.3 托盘菜单与 2.2 的深链都要能直接落到某个 Tab，刷新也不该退回「通用」。
 */
export const SETTINGS_TAB_IDS = [
  'general',
  'cloud',
  'tokens',
  'fields',
  'templates',
  'data',
  'logs',
  'backups',
  'about',
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export interface SettingsTabMeta {
  id: SettingsTabId;
  label: string;
}

export const SETTINGS_TABS: readonly SettingsTabMeta[] = [
  { id: 'general', label: '通用' },
  { id: 'cloud', label: '服务端市场' },
  { id: 'tokens', label: 'Token' },
  { id: 'fields', label: '字段定义' },
  { id: 'templates', label: '模板' },
  { id: 'data', label: '数据' },
  { id: 'logs', label: '日志与审计' },
  { id: 'backups', label: '备份' },
  { id: 'about', label: '关于' },
] as const;

/** 无 `?tab=` 时的落点（原型 7.1 侧边栏第一项）。 */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general';

export const TAB_SEARCH_KEY = 'tab';

/** 表外值不报错、回落到默认 Tab：深链可能是阶段二删掉或改名的 Tab。 */
export function parseSettingsTab(raw: string | null | undefined): SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(String(raw))
    ? (raw as SettingsTabId)
    : DEFAULT_SETTINGS_TAB;
}

export function settingsTabSearch(tab: SettingsTabId): string {
  return `?${TAB_SEARCH_KEY}=${tab}`;
}

export interface SettingsTabState {
  tab: SettingsTabId;
  select: (tab: SettingsTabId) => void;
}

export function useSettingsTab(): SettingsTabState {
  const search = useRouteSearchParams();
  const tab = parseSettingsTab(search.get(TAB_SEARCH_KEY));
  const select = useCallback((next: SettingsTabId) => {
    navigate('settings', settingsTabSearch(next));
  }, []);
  return useMemo(() => ({ tab, select }), [tab, select]);
}
