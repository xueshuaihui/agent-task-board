import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { transitions } from '@/lib/motion';

/**
 * 页面过渡（docs/motion-spec.md §1-L3 / §5.3）：入场淡入 + 上移 6px，240ms ease-emphasis
 * （transitions.rise）；退场纯淡出 140ms（transitions.exit）。宿主 AppShell 里用
 * `<AnimatePresence mode="wait">` 包住并给 `key={route.path}`（不含 search：同页换查询串
 * 不应整页重挂，见 app.tsx），路由切换时旧页退场、新页播放入场。总时长 ≈380ms（140+240），
 * >400ms 视为 bug。
 *
 * ⚠️ exit 严禁加位移/缩放：这层挂着 h-full（见下），退场期任何 transform/高度相关
 * 动画都会干扰 h-full 链（e4ae306 教训），只允许纯 opacity。
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
      exit={
        reducedMotion
          ? { opacity: 1, transition: { duration: 0 } }
          : { opacity: 0, transition: transitions.exit }
      }
      transition={reducedMotion ? { duration: 0 } : transitions.rise}
    >
      {children}
    </motion.div>
  );
}
