import { Bell, Diamond, Monitor, Moon, Sun } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { api, qk, useApiMutation, useNotifications, useSettings } from '@/api';
import type { Settings } from '@/api/types';
import { useUnreadStore, badgeText } from '@/app/store/unread';
import { taskListSearch } from '@/app/store/filters';
import { navigate, NAV_ORDER, ROUTES, useRoute } from '@/app/router';
import { IconButton } from '@/components/ui';
import { AccountMenu } from '@/features/auth';
import { useUnreadCount } from '@/ws';
import { springs } from '@/lib/motion';
import { applyUiTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';

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
 * 2.2 顶栏：Logo + 应用名 / 四个导航项 / 主题三态切换 / 一个通知铃铛。
 *
 * 视觉按 DESIGN.md §3：毛玻璃顶栏（.glass-bar）；导航激活项由 motion
 * `layoutId="nav-pill"` 的胶囊指示器滑动（springs.gentle）；铃铛角标数字
 * 变化带 springs.pop 弹跳。
 *
 * 主题切换即 `PATCH /settings { ui_theme }`（失效 qk.settings()，设置页与
 * useUiThemeSync 共用同一份缓存），同时乐观调用 applyUiTheme 立即生效，
 * 不等往返。深色色板在 globals.css 的 `[data-ui-theme="dark"]` 块。
 *
 * 三条刻意的「不做」（原型 2.2 末段）：不放依赖图入口（阶段二，见 lib/phase.ts）、
 * 不放全局筛选器、不放全局搜索框——筛选是页面级状态（app/store/filters.ts 一份真值），
 * 搜索属于任务列表页。全栏只有铃铛这一个角标：「审核」导航项再挂待审核数就会出现
 * 两个清零条件不同的数字。
 *
 * 铃铛只随 `notification.created` 变化：计数由服务端在事件载荷里算好，
 * 在 `src/ws/invalidate.ts` 一处写进 unread store（看板/列表响应也带同一个数），
 * 所以这里不再订阅第二次、也不轮询。
 */
export function TopBar() {
  const route = useRoute();
  const count = useUnreadCount();
  const badge = badgeText(count);
  const reducedMotion = useReducedMotion();

  const settings = useSettings();
  const uiTheme = settings.data?.ui_theme ?? 'system';

  // 未读数的首值来源（2.2 角标 = GET /notifications 的 unread_count）；面板列表属阶段二。
  useNotifications({ unread: true }, { staleTime: 60_000 });

  const clearReviewPending = useApiMutation<undefined, number>(
    () => api.notifications.markReviewPendingRead(),
    {
      invalidate: [qk.notificationsRoot, qk.boardRoot],
      onSuccess: (updated) => {
        // 先把角标按已清理的条数回落（等 /board 回来要一个往返），真值随后由失效查询校准。
        if (updated > 0) useUnreadStore.getState().bump(-updated);
      },
    },
  );

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
    <header className="glass-bar flex h-14 shrink-0 items-center gap-6 border-b border-border pl-6 pr-4">
      <div className="flex shrink-0 items-center gap-2">
        <Diamond className="size-6 shrink-0 text-primary" aria-hidden />
        <span className="text-logo text-text-primary">Jarvis Workbench</span>
      </div>

      <nav aria-label="主导航" className="flex min-w-0 flex-1 items-center gap-1">
        {NAV_ORDER.map((name) => {
          const active = route.name === name;
          return (
            <button
              key={name}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(name)}
              className={cn(
                'relative inline-flex items-center rounded-full px-3 py-1.5 text-nav transition-colors duration-120 ease-out',
                active ? 'text-primary' : 'text-text-secondary hover:text-primary',
              )}
            >
              {active ? (
                <motion.span
                  layoutId="nav-pill"
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-primary-light"
                  transition={reducedMotion ? { duration: 0 } : springs.gentle}
                />
              ) : null}
              <span className="relative">{ROUTES[name].label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          label={`切换主题（当前：${THEME_LABEL[uiTheme]}，点击切换为${THEME_LABEL[nextTheme(uiTheme)]}）`}
          icon={<ThemeIcon className="size-5" aria-hidden />}
          onClick={toggleTheme}
        />

        <div className="relative">
          <IconButton
            label="未读通知"
            icon={<Bell className="size-6" aria-hidden />}
            onClick={() => {
              // 2.2：不展开面板，直接跳「待审核」筛选视图，并把对应通知标已读。
              navigate('tasks', taskListSearch({ status: 'REVIEW' }));
              if (count > 0) clearReviewPending.mutate();
            }}
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

        {/* 2.3 账号下拉：显示名 / 切换账号 / 修改密码 / ADMIN 的用户管理 / 退出登录。 */}
        <AccountMenu />
      </div>
    </header>
  );
}
