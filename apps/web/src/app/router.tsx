import { useMemo, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import { cn } from '@/lib/cn';
import { skillsRouteCandidate } from '@/features/skills';

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
  // r6（§19.15·87，2026-09-28）：「分组」概念从 UI 整体下线，第二导航项改「需求」，
  // 页面主体是 type=需求 的任务列表（features/requirements/requirements-page.tsx）。
  requirements: { path: '/requirements', label: '需求' },
  review: { path: '/review', label: '审核' },
  // 0919 十四章 IA：任务列表不再占顶栏入口，但路由保留（看板工具栏「列表视图」跳这里）。
  tasks: { path: '/tasks', label: '任务' },
  // 0919 第十章：技能库。路由对象来自 features/skills 的候选（path/label 同形）。
  skills: skillsRouteCandidate,
  settings: { path: '/settings', label: '设置' },
} as const satisfies Record<string, { path: string; label: string }>;

export type RouteName = keyof typeof ROUTES;
export type RoutePath = (typeof ROUTES)[RouteName]['path'];

const PATH_TO_NAME = new Map<string, RouteName>(
  Object.entries(ROUTES).map(([name, route]) => [route.path, name as RouteName]),
);

/** 17.2：「依赖图」是阶段二入口，阶段一不渲染该项（见 lib/phase.ts）。 */
export const NAV_ORDER: readonly RouteName[] = ['board', 'requirements', 'skills', 'review', 'settings'];

/**
 * r6（§19.15·87）「分组」概念下线的旧深链兼容表：文档、托盘、历史 hash 里残留的
 * `#/groups`（含带 query 的 `/groups?x=1`）一律**重定向**到 `/requirements`，
 * query 原样保留。旧 hash 不落 404、也不静默回落看板；`/groups` 不再是活动路由。
 * 注意这只收口 hash 路由；REST 的 `GET /groups` 是数据真相，与此无关（§19.15·92）。
 */
export const LEGACY_PATH_REDIRECTS: Readonly<Record<string, string>> = {
  '/groups': '/requirements',
};

/**
 * 纯函数：把 location 串（形如 `/groups?x=1`）里的旧 path 换成新 path，query 原样保留；
 * 非旧链原样返回。hash 读取（`readHash`）与程序化跳转（`normalize`）两条入口共用它。
 */
export function rewriteLegacyLocation(location: string): string {
  const q = location.indexOf('?');
  const path = q === -1 ? location : location.slice(0, q);
  const target = LEGACY_PATH_REDIRECTS[path];
  if (!target) return location;
  return q === -1 ? target : `${target}${location.slice(q)}`;
}

interface RouterState {
  /** 形如 `/tasks?status=REVIEW`。 */
  location: string;
  locate: (to: string) => void;
}

function readHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw || raw === '/') return ROUTES.board.path;
  // r6：旧 `#/groups` 深链在这里映射（query 保留），不静默回落看板。
  return rewriteLegacyLocation(raw);
}

export const useRouterStore = create<RouterState>((set) => ({
  location: readHash(),
  locate: (to) => set({ location: normalize(to) }),
}));

function normalize(to: string): string {
  const path = to.startsWith('/') ? to : `/${to}`;
  // 程序化跳转同口映射：即使有代码仍递 `/groups…`（旧书签回调、外部注入 hash），
  //  store 里也只会出现新 path（§19.15·87）。
  return rewriteLegacyLocation(path);
}

export function startRouter(): () => void {
  const apply = () => {
    const raw = window.location.hash.replace(/^#/, '');
    const rewritten = rewriteLegacyLocation(raw);
    if (rewritten !== raw) {
      // 地址栏一并改写（replaceState 不增历史条目、不再触发 hashchange 自激，
      // 下面直接 locate 同一条串）。用户看到的必须是 `#/requirements…` 新地址，
      // 而不是「旧地址渲染了新页」。
      window.history.replaceState(null, '', `#${rewritten}`);
    }
    // 仍经 readHash 取：它带「空 hash 回落看板」的一条腿（rewrite 后地址栏已是新串）。
    useRouterStore.getState().locate(readHash());
  };
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
