import { useEffect, type ComponentType } from 'react';
import { AnimatePresence } from 'motion/react';
import { useSettings } from '@/api';
import { BoardPage } from '@/features/board';
import { ReviewPage } from '@/features/review';
import { SettingsPage } from '@/features/settings';
import { TaskListPage } from '@/features/task-list';
import { ChangePasswordPage, LoginPage, RequireAuth } from '@/features/auth';
import { applyUiTheme } from '@/lib/theme';
import { useWSWarning } from '@/ws';
import type { RouteName } from './router';
import { useRoute } from './router';
import { OverlaySlot } from './overlay-slot';
import { PageTransition } from './page-transition';
import { TopBar } from './top-bar';

/**
 * 2.1 应用外框：顶栏固定，主内容区吃掉剩余高度、自带 24px padding 与纵向滚动，
 * 抽屉/弹窗由 `OverlaySlot` 挂在外框之上（portal 到 body，不受这里的 overflow 裁剪）。
 *
 * 只渲染当前页：2.1 的「滚动位置保留」针对的是关窗到托盘（整棵树本来就不销毁），
 * 页面之间切换保留滚动不在需求内，而四页同挂会让设置页的查询在首屏就发出去。
 * 列头固定这类需求由页面内部自己再做一层 flex + 局部滚动（看板是 `useBoard` 的六列）。
 *
 * 壳层自己只读一个设置键：`ui_theme`（20.9，见 `useUiThemeSync`）。存值可能来自任何一条路径
 * （导入 JSON、另一个窗口、直接 `PATCH /settings`），只挂在设置页上就等于「存了不生效」。
 */
const PAGES: Record<Exclude<RouteName, 'login' | 'changePassword'>, ComponentType> = {
  board: BoardPage,
  review: ReviewPage,
  tasks: TaskListPage,
  settings: SettingsPage,
};

/**
 * 20.9 `ui_theme` → `<html data-ui-theme>`（`lib/theme.applyUiTheme`）。
 *
 * 走 `useSettings()` 而不是另发一次请求：key 与设置页共用 `qk.settings()`，于是启动时应用一次、
 * 此后任何失效重取都再应用一次，通用 Tab 那侧不需要自己接（`useSettingsWriter` 写成功后会更新同一份缓存）。
 * 深色色板在 globals.css 的 `[data-ui-theme="dark"]` 块（DESIGN.md §1.1），选「深色」即整体换肤；
 * 顶栏三态切换也走同一条链（乐观 applyUiTheme + PATCH 失效本查询）。
 */
function useUiThemeSync(): void {
  const settings = useSettings();
  const theme = settings.data?.ui_theme;
  useEffect(() => {
    // 设置没读回来之前按 20.9 的默认值落属性，与通用 Tab 的 `?? 'system'` 同口径。
    applyUiTheme(theme ?? 'system');
  }, [theme]);
}

/**
 * 根组件：认证页（0919 三章公开路由）不套工作区壳、不进认证守卫；
 * 其余路由包 `RequireAuth`——未登录跳 /login、首登强制改密跳 /change-password。
 */
export function AppShell() {
  const route = useRoute();
  if (route.name === 'login') return <LoginPage />;
  if (route.name === 'changePassword') return <ChangePasswordPage />;
  const Page = PAGES[route.name];
  return (
    <RequireAuth>
      <WorkspaceShell page={Page} routeKey={route.key} />
    </RequireAuth>
  );
}

function WorkspaceShell({
  page: Page,
  routeKey,
}: {
  page: ComponentType;
  routeKey: string;
}) {
  const ws = useWSWarning();
  useUiThemeSync();

  return (
    <div className="flex h-screen min-h-0 flex-col bg-bg-app text-text-primary">
      <TopBar />
      {ws.visible ? (
        <div
          role="status"
          className="shrink-0 border-b border-border bg-status-running-soft px-6 py-1.5 text-aux text-text-primary"
        >
          {ws.text}
        </div>
      ) : null}
      <main className="atb-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <AnimatePresence mode="wait">
          <PageTransition key={routeKey}>
            <Page />
          </PageTransition>
        </AnimatePresence>
      </main>
      <OverlaySlot />
    </div>
  );
}
