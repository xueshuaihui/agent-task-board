import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { transitions } from '@/lib/motion';

/**
 * 页面入场动画（DESIGN.md §3/§5）：淡入 + 上移 6px，240ms ease-emphasis。
 * AppShell 里用 `<AnimatePresence mode="wait">` 包住并给 `key={route.key}`，
 * 路由切换时旧页卸载、新页播放入场。
 *
 * prefers-reduced-motion 时不做位移、瞬时完成，只保留（即时的）内容替换。
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : transitions.rise}
    >
      {children}
    </motion.div>
  );
}
