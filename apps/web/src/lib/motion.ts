/**
 * motion（framer-motion 继任者）共享常量 —— docs/motion-spec.md §3.2。
 * 弹簧用于布局/弹出类动画，transitions 用于淡入/位移类入场。
 * 数值与 globals.css 1.6 节注释一一对应，改两处要同步。
 */
import type { Transition, Variants } from 'motion/react';

export const springs = {
  /** 布局动画、导航指示器滑动 */
  gentle: { type: 'spring', stiffness: 380, damping: 34 },
  /** 拖拽落点、开关滑块 */
  snappy: { type: 'spring', stiffness: 520, damping: 40 },
  /** 徽标数字、小元素弹出 */
  pop: { type: 'spring', stiffness: 600, damping: 30 },
} satisfies Record<string, Transition>;

export const transitions = {
  /** hover/按压级（CSS 侧 140ms）；存量档，并档后 ease 换 settle 或并入 exit */
  fade: { duration: 0.14, ease: 'easeOut' },
  /** 小浮层退场（Menu/Popover/搜索下拉） */
  menu: { duration: 0.1 },
  /** 浮层出入（Dialog/Menu/Tooltip） */
  overlay: { duration: 0.2, ease: [0.32, 0.72, 0, 1] },
  /** 页面入场 */
  rise: { duration: 0.24, ease: [0.32, 0.72, 0, 1] },
  /** 抽屉滑入 */
  drawer: { duration: 0.26, ease: [0.32, 0.72, 0, 1] },
  /** 抽屉/通知中心退场 */
  drawerOut: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
  /** 统一退场：列表移除/页面退场/toast 退场 */
  exit: { duration: 0.14, ease: 'easeOut' },
} satisfies Record<string, Transition>;

/**
 * 列表入场：父容器 listVariants + 子项 itemVariants，间隔 40ms（DESIGN.md §5）。
 *
 * 注意：子项**必须自己带 `initial="hidden"` + `animate="show"`**（见下），不能只靠
 * 父容器的 stagger 编排——数据异步到达晚于父容器首次动画时，后来挂载的子项不会被
 * 编排触发，会永远卡在 hidden 态（opacity:0），看起来就是内容「塌陷/空白」。
 * stagger 顺序改由 custom 索引 × 0.04s 的动态延迟保证（上限 240ms，长列表不拖尾）。
 */
export const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: (index: number = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.24, ease: [0.32, 0.72, 0, 1], delay: Math.min(index * 0.04, 0.24) },
  }),
};
