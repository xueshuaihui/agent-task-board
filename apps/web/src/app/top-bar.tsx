import { Bell, Monitor, Moon, Sun } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { api, qk, useApiMutation, useNotifications, useSettings } from '@/api';
import type { Settings } from '@/api/types';
import { badgeText } from '@/app/store/unread';
import { useShellStore } from '@/app/store/shell';
import { IconButton } from '@/components/ui';
import { AgentStatusChip } from '@/app/agent-status-chip';
import { GlobalSearch } from '@/app/global-search';
import { useUnreadCount } from '@/ws';
import { springs } from '@/lib/motion';
import { applyUiTheme } from '@/lib/theme';

type UiTheme = Settings['ui_theme'];

/** DESIGN.md §3：三态循环 浅色 → 深色 → 跟随系统。 */
const THEME_CYCLE: readonly UiTheme[] = ['light', 'dark', 'system'];

const THEME_ICON: Record<UiTheme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

const THEME_LABEL: Record<UiTheme, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

function nextTheme(current: UiTheme): UiTheme {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
}

/**
 * v0.0.4 W9 13.1：顶部工具栏（不是导航——导航已移入左侧 Sidebar）。
 * 承载全局搜索（2.4，⌘K）+ 主题三态切换 + 通知铃铛（角标 + 打开通知中心）
 * + Agent 活跃状态 chip（B2b：执行中数量与最近活动，无内容时整条隐藏）。
 *
 * 页面级工具栏（看板/技能/设置各自的视图切换、筛选、操作）由各页面自己渲染
 * （`features/board/toolbar.tsx` 等），这条全局栏只放跨页复用件。
 *
 * 铃铛不再直接跳「待审核」列表（v0.0.3 行为），改为开合通知中心面板（13.9）；
 * 计数仍只随 `notification.created` 变化（`ws/invalidate.ts` 一处写 unread store）。
 */
export function TopBar() {
  const count = useUnreadCount();
  const badge = badgeText(count);
  const reducedMotion = useReducedMotion();

  const settings = useSettings();
  const uiTheme = settings.data?.ui_theme ?? 'system';

  const notificationOpen = useShellStore((state) => state.notificationOpen);
  const toggleNotification = useShellStore((state) => state.toggleNotification);

  // 未读数首值来源（2.2 角标 = GET /notifications 的 unread_count）；后续增量只随 WS 走。
  useNotifications({ unread: true }, { staleTime: 60_000 });

  const setTheme = useApiMutation<UiTheme, Settings>(
    (theme) => api.settings.patch({ ui_theme: theme }),
    { invalidate: [qk.settings()] },
  );

  const toggleTheme = () => {
    const next = nextTheme(uiTheme);
    // 乐观落 `<html data-ui-theme>`，PATCH 成功后失效 qk.settings() 校准缓存。
    applyUiTheme(next);
    setTheme.mutate(next);
  };

  const ThemeIcon = THEME_ICON[uiTheme];

  return (
    <header className="glass-bar flex h-14 shrink-0 items-center gap-4 border-b border-border pl-4 pr-3">
      {/* 2.4：全局搜索占工具栏左部，剩余空间给它并限最大宽。 */}
      <div className="flex min-w-0 flex-1 items-center">
        <GlobalSearch />
      </div>

      <AgentStatusChip />

      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={`切换主题（当前：${THEME_LABEL[uiTheme]}，点击切换为${THEME_LABEL[nextTheme(uiTheme)]}）`}
          icon={<ThemeIcon className="size-5" aria-hidden />}
          onClick={toggleTheme}
        />

        <div className="relative">
          <IconButton
            label={notificationOpen ? '关闭通知中心' : '打开通知中心'}
            aria-expanded={notificationOpen}
            aria-haspopup="dialog"
            icon={<Bell className="size-6" aria-hidden />}
            onClick={toggleNotification}
          />
          {badge ? (
            <motion.span
              key={count}
              initial={reducedMotion ? false : { scale: 0.6 }}
              animate={{ scale: 1 }}
              transition={springs.pop}
              className="pointer-events-none absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-badge bg-status-review px-[5px] text-badge text-text-inverse"
            >
              {badge}
            </motion.span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
