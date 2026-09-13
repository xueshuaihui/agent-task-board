import { useCallback, useEffect, useState } from 'react';
import { useWSEvent } from '@/ws';

/**
 * 只影响**渲染态**的 WS 覆盖层（10.1、7.3）：`run.progress` 与 `lease.expired` 到得比
 * `/board` 的重取快，卡片先用事件里的值画进度与红色倒计时，等服务端数据回来再让位。
 *
 * 这里刻意**不**改任务状态、不改列位置——失效只由 `src/ws/invalidate.ts` 负责，
 * 本地增量会和 WS 的整表重取互相覆盖（PRD 7.2「不做先动后回滚」）。
 */
export interface RunOverlay {
  progress?: number;
  progressMsg?: string | null;
  /** 倒计时归零后的变红提示：回收由服务端判定，本地只是画红。 */
  leaseExpired?: boolean;
}

const EMPTY: RunOverlay = {};

export function useRunOverlay(): {
  overlayOf: (taskId: string) => RunOverlay;
  drop: (taskId: string) => void;
} {
  const [map, setMap] = useState<Readonly<Record<string, RunOverlay>>>({});

  useWSEvent(['run.progress'], ({ data }) => {
    setMap((current) => ({
      ...current,
      [data.task_id]: {
        ...current[data.task_id],
        progress: data.progress,
        progressMsg: data.message,
      },
    }));
  });

  useWSEvent(['lease.expired'], ({ data }) => {
    setMap((current) => ({
      ...current,
      [data.task_id]: { ...current[data.task_id], leaseExpired: true },
    }));
  });

  const drop = useCallback((taskId: string) => {
    setMap((current) => {
      if (!(taskId in current)) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }, []);

  // 换列 = 这条 Run 已经结束（认领/回写/强制停止都发 task.moved），覆盖值就此作废。
  useWSEvent(['task.moved'], ({ data }) => drop(data.id));
  useWSEvent(['task.deleted'], ({ data }) => drop(data.task_id));

  const overlayOf = useCallback((taskId: string): RunOverlay => map[taskId] ?? EMPTY, [map]);

  return { overlayOf, drop };
}

/**
 * 1s 一跳的本地时钟，给租约倒计时用；**只有执行中卡片**会挂载它，
 * 否则整块看板每秒重渲染一次，五十大卡片的列会直接卡住。
 */
export function useLeaseTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
