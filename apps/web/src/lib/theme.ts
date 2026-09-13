import type { Settings } from '@/api/types';

type UiTheme = Settings['ui_theme'];

/**
 * 20.9 `ui_theme` 落到 `<html data-ui-theme>`。
 * 注意：原型 v1.1 只给了浅色一套 token（1.1），深色一套尚未定义，
 * 所以这里只写属性、不写色板切换——设置页可以存值，界面仍是浅色。
 */
export function applyUiTheme(theme: UiTheme): void {
  const resolved: UiTheme = theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
  document.documentElement.dataset.uiTheme = resolved;
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
