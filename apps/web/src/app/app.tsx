import { useEffect, type ComponentType } from 'react';
import { AnimatePresence } from 'motion/react';
import { useSettings } from '@/api';
import { BoardPage } from '@/features/board';
import { GroupsPage } from '@/features/groups';
import { ReviewPage } from '@/features/review';
import { SettingsPage } from '@/features/settings';
import { SkillLibraryPage } from '@/features/skills';
import { TaskListPage } from '@/features/task-list';
import { applyUiTheme } from '@/lib/theme';
import { useShellStore } from '@/app/store/shell';
import { useWSWarning } from '@/ws';
import type { RouteName } from './router';
import { useRoute } from './router';
import { OverlaySlot } from './overlay-slot';
import { PageTransition } from './page-transition';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { NotificationCenter } from './notification-center';

/**
 * 2.1 应用外框：v0.0.4 W9 起为「左侧导航 + 顶部工具栏 + 内容区」（13.1）。
 * 左栏 `Sidebar`（看板/分组/技能/审核/设置，可折叠到 64px）常驻，右侧上下分「顶部工具栏 + 主内容区」。
 * 主内容区吃掉剩余高度、自带 padding 与纵向滚动，抽屉/弹窗/通知中心由 `OverlaySlot`/`NotificationCenter`
 * 挂在外框之上（portal 到 body，不受这里的 overflow 裁剪）。
 *
 * 只渲染当前页：2.1 的「滚动位置保留」针对的是关窗到托盘（整棵树本来就不销毁），
 * 页面之间切换保留滚动不在需求内，而四页同挂会让设置页的查询在首屏就发出去。
 * 列头固定这类需求由页面内部自己再做一层 flex + 局部滚动（看板是 `useBoard` 的六列）。
 *
 * 壳层自己只读一个设置键：`ui_theme`（20.9，见 `useUiThemeSync`）。存值可能来自任何一条路径
 * （导入 JSON、另一个窗口、直接 `PATCH /settings`），只挂在设置页上就等于「存了不生效」。
 */
const PAGES: Record<RouteName, ComponentType> = {
  board: BoardPage,
  groups: GroupsPage,
  review: ReviewPage,
  tasks: TaskListPage,
  skills: SkillLibraryPage,
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
 * 根组件：纯本地单用户，无登录门禁——应用直接进入主工作区。
 */
export function AppShell() {
  const route = useRoute();
  const Page = PAGES[route.name];
  // key 只认 path 不认 search：`#/settings?tab=x` 这类同页换参走页面内响应
  //（设置 Tab 派生渲染、列表页 filtersFromSearch 的 useEffect），不该触发整页
  // exit+rise（≈380ms 空白）与全部查询重取。
  return <WorkspaceShell page={Page} routeKey={route.path} />;
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
  const navCollapsed = useShellStore((state) => state.navCollapsed);

  // 13.8：左弹出的浮层（通知中心）覆盖内容区、不覆盖左侧导航。抽屉/通知面板都 portal 到
  // `document.body`，变量必须挂在 `<html>` 上，挂在壳层 div 上 portal 出去的元素读不到。
  useEffect(() => {
    document.documentElement.style.setProperty('--atb-nav-w', navCollapsed ? '64px' : '200px');
  }, [navCollapsed]);

  return (
    <div className="flex h-screen min-h-0 bg-bg-app text-text-primary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
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
      </div>
      <NotificationCenter />
      <OverlaySlot />
    </div>
  );
}
