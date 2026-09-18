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
      // 高度链的一环：main 是定高滚动容器，这层若没有高度，页面里的 h-full
      //（看板列高、列内滚动）全部落空，列会塌成内容高、溢出变成整页滚动条。
      className="h-full"
      initial={reducedMotion ? { opacity: 1 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : transitions.rise}
    >
      {children}
    </motion.div>
  );
}
