import type { Settings } from '@/api/types';

type UiTheme = Settings['ui_theme'];

/**
 * 20.9 `ui_theme` 落到 `<html data-ui-theme>`。
 * 深浅两套色板都在 globals.css（浅色为 `@theme` 默认值，深色挂在 `[data-ui-theme="dark"]`，
 * 见 DESIGN.md §1.1），所以写完属性即整体换肤；'system' 按 prefers-color-scheme 解析。
 */
export function applyUiTheme(theme: UiTheme): void {
  const resolved: UiTheme = theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
  document.documentElement.dataset.uiTheme = resolved;
}

function prefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
