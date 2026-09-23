import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { ReviewConclusion, ReturnTarget } from '@/api/types';

/** v0.0.4 W9 13.2：左侧导航展开 200px / 折叠 64px，折叠态持久化到本地。 */
const NAV_COLLAPSED_KEY = 'atb.nav.collapsed';

/**
 * 动态收起断点：窗口宽度 < win-lg(1200px，globals.css `--breakpoint-win-lg`) 时
 * 未显式设置过折叠态的导航自动收成 64px 图标轨，把宽度还给内容区。
 */
const NAV_NARROW_QUERY = '(max-width: 1199.98px)';

/** null = 用户没显式表过态，跟随窗口宽度；true/false = 手动折叠/展开，优先于断点。 */
function readNavCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(NAV_COLLAPSED_KEY);
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    return null;
  }
}

function writeNavCollapsed(collapsed: boolean | null): void {
  try {
    if (collapsed === null) window.localStorage.removeItem(NAV_COLLAPSED_KEY);
    else window.localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* 隐私模式 / 存储不可用：折叠态只影响本次会话，不影响正确性。 */
  }
}

/** 导航的「生效折叠态」：手动偏好 ?? 窄窗口自动收起。Sidebar 与 --atb-nav-w 共用。 */
export function useNavCollapsed(): boolean {
  const manual = useShellStore((state) => state.navCollapsed);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NAV_NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NAV_NARROW_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return manual ?? narrow;
}

/**
 * 全局 UI 状态里只放「跨页面」的两件事：详情抽屉开在哪个任务、WS 连接态提示是否已展示。
 * 页面级状态（筛选、分页、选择集）留在各自 feature 里——顶栏不放筛选器的理由见原型 2.2。
 */

/**
 * 审核表单的预填通道（PRD 4.5 末段 + 原型 3.7 / 4.9）。
 *
 * 为什么必须在 store 里带：打开表单的入口有四个（看板拖到 🔒 列、抽屉「审核 →」与
 * 「退回重跑」、列表行 `⋯`、审核页行内按钮），而表单只有一份（原型 5.3「同一组件、两处外壳」）。
 * 只带 id 就把「拖放目标列 = 退回目标」「退回重跑 = 结论驳回」这两条文档要求的上下文丢了。
 * 三字段仍必填——预填只改两个单选项，不构成绕过（6.5 第 3 条）。
 */
export interface ReviewPrefill {
  /** 拖到需求池／待执行与「退回重跑」= `REJECT`；拖到已完成 = `APPROVE`。缺省按表单默认值。 */
  conclusion?: ReviewConclusion;
  /** 20.2 `return_to`：只有驳回时随请求发出，所以只在驳回路径上给值。 */
  returnTo?: ReturnTarget;
}

interface ShellState {
  /** 非空即抽屉打开；路由切换不关闭它（2.1：窗口内导航不重置视图）。 */
  openTaskId: string | null;
  openTask: (id: string) => void;
  closeTask: () => void;
  /** 审核表单（720px 模态）的宿主：看板拖拽、抽屉「审核 →」、审核页内嵌共用一个实现。 */
  reviewTaskId: string | null;
  /** 与 `reviewTaskId` 同生命周期：`closeReview` 一起清，避免上一次入口的预填漏到下一次。 */
  reviewPrefill: ReviewPrefill | null;
  openReview: (id: string, prefill?: ReviewPrefill | null) => void;
  closeReview: () => void;
  /** v0.0.4 W9 13.2：左导航折叠偏好（200px ↔ 64px）；null=跟随窗口宽度动态收起，本地持久化。 */
  navCollapsed: boolean | null;
  setNavCollapsed: (collapsed: boolean) => void;
  /** v0.0.4 W9 13.9：通知中心弹层开合（顶栏铃铛与面板共用一份状态）。 */
  notificationOpen: boolean;
  setNotificationOpen: (open: boolean) => void;
  toggleNotification: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  openTaskId: null,
  openTask: (id) => set({ openTaskId: id }),
  closeTask: () => set({ openTaskId: null }),
  reviewTaskId: null,
  reviewPrefill: null,
  openReview: (id, prefill) => set({ reviewTaskId: id, reviewPrefill: prefill ?? null }),
  closeReview: () => set({ reviewTaskId: null, reviewPrefill: null }),
  navCollapsed: readNavCollapsed(),
  setNavCollapsed: (collapsed) => {
    writeNavCollapsed(collapsed);
    set({ navCollapsed: collapsed });
  },
  notificationOpen: false,
  setNotificationOpen: (open) => set({ notificationOpen: open }),
  toggleNotification: () => set((state) => ({ notificationOpen: !state.notificationOpen })),
}));
