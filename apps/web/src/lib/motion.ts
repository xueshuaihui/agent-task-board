/**
 * motion（framer-motion 继任者）共享常量 —— DESIGN.md §1.6。
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
  /** hover/按压级（CSS 侧 140ms） */
  fade: { duration: 0.14, ease: 'easeOut' },
  /** 浮层出入（Dialog/Menu/Tooltip） */
  overlay: { duration: 0.2, ease: [0.32, 0.72, 0, 1] },
  /** 页面入场 */
  rise: { duration: 0.24, ease: [0.32, 0.72, 0, 1] },
  /** 抽屉滑入 */
  drawer: { duration: 0.26, ease: [0.32, 0.72, 0, 1] },
} satisfies Record<string, Transition>;

/** 列表入场编排：父容器 variants + 子项 itemVariants，间隔 40ms（DESIGN.md §5）。 */
export const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.02 } },
};

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.32, 0.72, 0, 1] } },
};
