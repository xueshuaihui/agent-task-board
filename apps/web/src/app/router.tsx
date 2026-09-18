import { useMemo, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import { cn } from '@/lib/cn';

/**
 * 极薄 hash 路由（不引第三方 router）。
 *
 * 为什么自研：2.1 要求「窗口内导航不出现浏览器前进后退」，四个入口也不需要嵌套路由、
 * 数据加载器、路由级代码分割这些能力；hash 方案还有个副产品——`tauri://localhost`
 * 下静态资源以 `file` 语义加载时，pushState 路径刷新会 404。
 * 2.1 的「滚动位置与筛选条件在窗口隐藏后保留」也因此自然成立：组件树不被卸载。
 */

export const ROUTES = {
  board: { path: '/board', label: '看板' },
  review: { path: '/review', label: '审核' },
  tasks: { path: '/tasks', label: '任务' },
  settings: { path: '/settings', label: '设置' },
  // 0919 三章：公开路由（登录 / 首登强制改密），不在主导航出现（NAV_ORDER 不含），
  // app.tsx 的 AppShell 按名字分流到认证页而非工作区壳。
  login: { path: '/login', label: '登录' },
  changePassword: { path: '/change-password', label: '修改密码' },
} as const satisfies Record<string, { path: string; label: string }>;

export type RouteName = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteName]['path'];

const PATH_TO_NAME = new Map<string, RouteName>(
  Object.entries(ROUTES).map(([name, route]) => [route.path, name as RouteName]),
);

/** 17.2：「依赖图」是阶段二入口，阶段一不渲染该项（见 lib/phase.ts）。 */
export const NAV_ORDER: readonly RouteName[] = ['board', 'review', 'tasks', 'settings'];

interface RouterState {
  /** 形如 `/tasks?status=REVIEW`。 */
  location: string;
  locate: (to: string) => void;
}

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw === '/') return ROUTES.board.path;
  return raw;
}

export const useRouterStore = create<RouterState>((set) => ({
  location: readHash(),
  locate: (to) => set({ location: normalize(to) }),
}));

function normalize(to: string): string {
  const path = to.startsWith('/') ? to : `/${to}`;
  return path;
}

export function startRouter(): () => void {
  const apply = () => useRouterStore.getState().locate(readHash());
  apply();
  window.addEventListener('hashchange', apply);
  // 2.1：不给用户留下「后退到上一个页面」的入口。
  if (!window.location.hash) window.location.replace(`#${ROUTES.board.path}`);
  return () => window.removeEventListener('hashchange', apply);
}

/** 拼跳转地址：`tasksHref(taskListSearch({ status: 'REVIEW' }))`。 */
export function hrefFor(name: RouteName, search = ''): string {
  return `#${ROUTES[name].path}${search}`;
}

export function navigate(name: RouteName, search = ''): void {
  const next = `${ROUTES[name].path}${search}`;
  if (window.location.hash === `#${next}`) {
    useRouterStore.getState().locate(next);
    return;
  }
  window.location.hash = next;
}

export interface Route {
  name: RouteName;
  path: string;
  search: URLSearchParams;
  /** 整条 location 字符串，做 key 用。 */
  key: string;
}

export function useRoute(): Route {
  const location = useRouterStore((state) => state.location);
  return useMemo(() => {
    const [path, query = ''] = location.split('?');
    const known = PATH_TO_NAME.get(path);
    return {
      name: known ?? 'board',
      path: known ? path : ROUTES.board.path,
      search: new URLSearchParams(query),
      key: location,
    };
  }, [location]);
}

/** 列表页/看板跳转时用它在挂载时水合筛选（app/store/filters.ts 的 filtersFromSearch）。 */
export function useRouteSearchParams(): URLSearchParams {
  return useRoute().search;
}

export function useNavigate(): (name: RouteName, search?: string) => void {
  return useMemo(() => (name: RouteName, search = '') => navigate(name, search), []);
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: RouteName;
  search?: string;
  children: ReactNode;
}

export function Link({ to, search = '', className, children, ...rest }: LinkProps) {
  return (
    <a
      href={hrefFor(to, search)}
      className={cn('text-primary hover:text-primary-hover', className)}
      onClick={(event) => {
        // 交给 hashchange 统一驱动，避免中键/复合键点击时行为不一致。
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to, search);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
