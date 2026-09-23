import {
  ClipboardList,
  Diamond,
  FolderTree,
  Kanban,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ComponentType, SVGProps } from 'react';
import { navigate, NAV_ORDER, ROUTES, type RouteName, useRoute } from '@/app/router';
import { useNavCollapsed, useShellStore } from '@/app/store/shell';
import { cn } from '@/lib/cn';
import { springs } from '@/lib/motion';

/**
 * v0.0.4 W9 13.1/13.2：左侧导航。宽度 200px、可折叠到 64px（13.2 表），
 * 导航项高度 44px（h-11），选中态「左侧 3px 主色条 + 主色浅底」。
 *
 * PRD 13.2 只列了「看板 / 技能 / 设置」三项，但存量还有分组/审核两个独立页面，
 * 为不丢入口这里保留 5 项导航（看板/分组/技能/审核/设置），路由与深链不变。
 * 折叠态：手动偏好优先，未表过态时窗口 <win-lg 动态收成 64px 图标轨（`useNavCollapsed`）。
 */
const NAV_ICON: Record<RouteName, ComponentType<SVGProps<SVGSVGElement>>> = {
  board: Kanban,
  groups: FolderTree,
  skills: Sparkles,
  review: ClipboardList,
  settings: SettingsIcon,
  // tasks 不在 NAV_ORDER（看板工具栏「列表视图」进入），给一个图标只为满足 Record 完整性。
  tasks: ListTodo,
};

export function Sidebar() {
  const route = useRoute();
  const collapsed = useNavCollapsed();
  const setNavCollapsed = useShellStore((state) => state.setNavCollapsed);
  const reducedMotion = useReducedMotion();

  return (
    <aside
      className={cn(
        'z-30 flex shrink-0 flex-col border-r border-border bg-bg-surface transition-[width] duration-200 ease-settle',
        collapsed ? 'w-16' : 'w-[200px]',
      )}
    >
      {/* 品牌 + 折叠开关：13.1 顶部 [◆] 是纯品牌标识；开/收用独立的 PanelLeft 按钮
          （展开态在标题行右端，折叠态在菱形下方），与分组侧栏折叠入口同款式。 */}
      <div
        className={cn(
          'shrink-0 border-b border-border',
          collapsed ? 'flex flex-col items-center gap-1 px-0 py-2' : 'flex h-14 items-center gap-2 px-4',
        )}
      >
        <Diamond className="size-6 shrink-0 text-primary" aria-hidden />
        {!collapsed ? (
          <span className="min-w-0 flex-1 truncate text-logo text-text-primary">Jarvis</span>
        ) : null}
        <button
          type="button"
          onClick={() => setNavCollapsed(!collapsed)}
          aria-label={collapsed ? '展开导航' : '折叠导航'}
          title={collapsed ? '展开导航' : '折叠导航'}
          aria-expanded={!collapsed}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-text-secondary transition-colors duration-140 ease-settle hover:bg-bg-muted hover:text-text-primary"
        >
          {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
        </button>
      </div>

      <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {NAV_ORDER.map((name) => {
          const active = route.name === name;
          const Icon = NAV_ICON[name];
          const label = ROUTES[name].label;
          return (
            <button
              key={name}
              type="button"
              aria-current={active ? 'page' : undefined}
              title={collapsed ? label : undefined}
              onClick={() => navigate(name)}
              className={cn(
                'relative flex h-11 items-center rounded-control text-nav transition-colors duration-140 ease-settle',
                collapsed ? 'justify-center' : 'gap-3 px-3',
                active
                  ? 'bg-primary-light font-medium text-primary'
                  : 'text-text-secondary hover:bg-bg-muted hover:text-text-primary',
              )}
            >
              {/* 13.2 选中态：左侧 3px 主色条，由 motion layoutId 在项间滑动。 */}
              {active ? (
                <motion.span
                  layoutId="nav-active-bar"
                  aria-hidden
                  className="absolute inset-y-1 left-0 w-[3px] rounded-r-full bg-primary"
                  transition={reducedMotion ? { duration: 0 } : springs.gentle}
                />
              ) : null}
              <Icon className="size-5 shrink-0" aria-hidden />
              {!collapsed ? <span className="truncate">{label}</span> : null}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
