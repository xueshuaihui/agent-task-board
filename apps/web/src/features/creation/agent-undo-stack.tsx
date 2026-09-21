import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { motion, useReducedMotion } from 'motion/react';
import { Undo2 } from 'lucide-react';
import { api, errorMessage } from '@/api';
import { useShellStore } from '@/app/store/shell';
import { Button, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { transitions } from '@/lib/motion';
import { useWSEvent } from '@/ws';

/**
 * §8.6 直建 5 秒撤销（W8-a4，direct/silent 两模式）：
 * 「✅ 任务已创建 · T-xxxx · [查看任务] [撤销]」浮层，观察通道是 WS
 * `task.created` 载荷的 `origin_type === 'agent'`（api 侧 W8-a4 透出；读路径
 * `/tasks`、`/board` 同步带 `origin_type`，但撤销窗以事件到达时刻起算最准，
 * 且 §13 读取模型禁止事件做本地增量，这里只当「新到达的 agent 直建」信号用）。
 *
 * 与轻确认卡片的终态区保持同一交互语汇：同一个右下角宿主（creation-host 的栈）、
 * 同一套按钮（outlineDanger「撤销 Ns」）、同一个 `DELETE /tasks/{id}`
 * （api.tasks.remove，§8.6 兼作撤销通道；服务端守卫「仅 origin=agent 且未领取」，
 * §13.9 / W8-a3 已实现）。
 *
 * 收口路径（时限归前端，服务端不复核 5 秒窗）：
 * - 窗口内点击成功 → 就地转「已撤销」，短暂停留后消失；看板刷新由服务端广播的
 *   `task.deleted` 走 ws/invalidate 统一失效，这里不重复写失效逻辑。
 * - 窗口内点击但任务已被领取（DELETE 回 4xx）→ 失败 toast + 入口消失。
 * - 超 5 秒未点 → 入口消失。
 */

/** §8.6「创建后 5 秒内可撤销」的窗口长度，与 creation-card.tsx 同一常量口径。 */
const UNDO_WINDOW_MS = 5_000;
/** 撤销成功后「已撤销」回显的停留时长，让用户确认结果。 */
const DONE_LINGER_MS = 3_000;

interface AgentCreatedEntry {
  taskId: string;
  /** 事件到达时刻：撤销窗起点（本地时钟，与创建卡片 createdAtRef 同一做法）。 */
  createdAtMs: number;
  undone: boolean;
  undoneAtMs: number | null;
}

interface AgentUndoState {
  entries: AgentCreatedEntry[];
  push: (taskId: string) => void;
  markUndone: (taskId: string) => void;
  remove: (taskId: string) => void;
  /** 定时器每跳调用：超窗未撤销的消失、已撤销过留痕期的消失。 */
  prune: (now: number) => void;
}

export const useAgentUndoStore = create<AgentUndoState>((set) => ({
  entries: [],
  push: (taskId) =>
    set((state) =>
      state.entries.some((entry) => entry.taskId === taskId)
        ? state
        : {
            entries: [
              ...state.entries,
              { taskId, createdAtMs: Date.now(), undone: false, undoneAtMs: null },
            ],
          },
    ),
  markUndone: (taskId) =>
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.taskId === taskId ? { ...entry, undone: true, undoneAtMs: Date.now() } : entry,
      ),
    })),
  remove: (taskId) =>
    set((state) => ({ entries: state.entries.filter((entry) => entry.taskId !== taskId) })),
  prune: (now) =>
    set((state) => {
      const entries = state.entries.filter((entry) =>
        entry.undone
          ? (entry.undoneAtMs ?? now) + DONE_LINGER_MS > now
          : now - entry.createdAtMs < UNDO_WINDOW_MS,
      );
      return entries.length === state.entries.length ? state : { entries };
    }),
}));

export function AgentUndoStack() {
  const reduced = useReducedMotion();
  const toast = useToast();
  const entries = useAgentUndoStore((state) => state.entries);
  const push = useAgentUndoStore((state) => state.push);
  const markUndone = useAgentUndoStore((state) => state.markUndone);
  const remove = useAgentUndoStore((state) => state.remove);
  const prune = useAgentUndoStore((state) => state.prune);
  const [tick, setTick] = useState(() => Date.now());
  const busyRef = useRef<ReadonlySet<string>>(new Set());

  useWSEvent(['task.created'], ({ data }) => {
    // 只观察 agent 直建（direct/silent）：用户自建与拆解确认建的任务不挂撤销入口。
    if (data.origin_type === 'agent') push(data.id);
  });

  // 秒级倒计时 + 到期回收：无入口时不挂定时器。
  useEffect(() => {
    if (entries.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTick(now);
      prune(now);
    }, 250);
    return () => clearInterval(timer);
  }, [entries.length, prune]);

  const undo = async (entry: AgentCreatedEntry) => {
    if (busyRef.current.has(entry.taskId)) return;
    busyRef.current = new Set([...busyRef.current, entry.taskId]);
    try {
      await api.tasks.remove(entry.taskId);
      markUndone(entry.taskId);
      setTick(Date.now());
      toast.success('已撤销，任务已删除');
    } catch (error) {
      // 多半是「已被领取」被 DELETE 守卫拒绝（4xx）：入口消失，与超窗同一归宿。
      toast.error(errorMessage(error));
      remove(entry.taskId);
    } finally {
      busyRef.current = new Set([...busyRef.current].filter((id) => id !== entry.taskId));
    }
  };

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map((entry) => {
        const msLeft = Math.max(0, UNDO_WINDOW_MS - (tick - entry.createdAtMs));
        return (
          <motion.article
            key={entry.taskId}
            {...(reduced
              ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
              : {
                  initial: { opacity: 0, y: 12, scale: 0.98 },
                  animate: { opacity: 1, y: 0, scale: 1 },
                  exit: { opacity: 0, y: 8, scale: 0.98 },
                })}
            transition={transitions.overlay}
            className={cn(
              'pointer-events-auto w-[360px] max-w-[calc(100vw-2rem)] rounded-card border border-border bg-bg-surface shadow-pop',
            )}
            role="status"
          >
            <div className="flex flex-col gap-1.5 px-3 py-2.5">
              <p className="text-aux font-medium text-text-primary">✅ 任务已创建</p>
              <p className="truncate text-aux text-text-secondary">{entry.taskId} · Agent 直建</p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => useShellStore.getState().openTask(entry.taskId)}
                >
                  查看任务
                </Button>
                {entry.undone ? (
                  <span className="ml-auto text-aux text-text-tertiary">已撤销</span>
                ) : msLeft > 0 ? (
                  <Button
                    variant="outlineDanger"
                    size="sm"
                    className="ml-auto"
                    icon={<Undo2 className="size-3.5" aria-hidden />}
                    onClick={() => void undo(entry)}
                  >
                    撤销 {Math.ceil(msLeft / 1000)}s
                  </Button>
                ) : null}
              </div>
            </div>
          </motion.article>
        );
      })}
    </>
  );
}
