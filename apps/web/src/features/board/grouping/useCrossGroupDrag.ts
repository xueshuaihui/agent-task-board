import { useCallback, useMemo, useState } from 'react';
import type { DragEndEvent } from '@dnd-kit/core';
import type { TaskStatus } from '@/api/types';
import type { GroupableTask } from './dimensions';
import { classifyDrag, patchForLane, type GroupMovePatch } from './grouping';

/**
 * 4.9 跨分组/跨泳道拖拽：命中「跨分组」时先弹确认（4.9 文案），确认后才回调。
 * 同分组内跨列（状态流转）不弹窗，直接回调 onChangeStatus。
 *
 * 接缝：onChangeGroup / onChangeStatus 由 board 页接真实 mutation
 * （onChangeGroup 的 patch 字段名等后端归属 API 定了以后在 patchForLane 里对齐）。
 */
export interface CrossGroupDragCallbacks {
  /** 4.9「这将同时更改任务的所属项目」：归属补丁 + 可选状态。 */
  onChangeGroup: (taskId: string, patch: GroupMovePatch, to?: { status?: TaskStatus }) => void;
  /** 同分组内跨列 = 状态流转。 */
  onChangeStatus: (taskId: string, status: TaskStatus) => void;
}

export interface DragPayload {
  taskId: string;
  fromLaneKey: string;
  toLaneKey: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
}

interface ConfirmState {
  task: GroupableTask;
  payload: DragPayload;
}

export interface CrossGroupDragApi {
  /** 非空时渲染确认对话框（4.9）。 */
  confirm: ConfirmState | null;
  confirmText: string | null;
  /** dnd-kit 的 onDragEnd：内部识别 lane / column 落点，跨分组时转确认而不是直接改。 */
  onDragEnd: (event: DragEndEvent) => void;
  accept: () => void;
  cancel: () => void;
}

/** dnd-kit id 约定：泳道容器 `lane:{key}`，列容器 `column:{laneKey}:{status}`，卡片 `task:{id}`。 */
export function parseDndId(id: string): { kind: string; parts: string[] } {
  const [kind, ...parts] = id.split(':');
  return { kind: kind ?? '', parts };
}

export function useCrossGroupDrag(options: {
  callbacks: CrossGroupDragCallbacks;
  /** 泳道 key → 展示名，确认文案用（4.9）。 */
  laneLabels: () => Record<string, string>;
  /** 泳道 key → 主分组维度，决定 patch 形状。 */
  laneDimensions: () => Record<string, string>;
  tasks: () => readonly GroupableTask[];
}): CrossGroupDragApi {
  const { callbacks } = options;
  const [pending, setPending] = useState<ConfirmState | null>(null);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const active = parseDndId(String(event.active.id));
      const over = event.over ? parseDndId(String(event.over.id)) : null;
      if (active.kind !== 'task' || !over) return;
      const task = options.tasks().find((item) => item.id === active.parts[0]);
      if (!task) return;

      // 落在泳道容器上：视为「跨到该泳道、状态不变」。
      const overIsLane = over.kind === 'lane';
      const toLaneKey = overIsLane ? over.parts[0] : over.parts[0];
      const fromStatus = task.status as TaskStatus;
      const toStatus: TaskStatus = overIsLane
        ? fromStatus
        : (over.parts[1] as TaskStatus);

      // 来源泳道由拖拽 data 带上（Swimlane 渲染时在卡片 data 里给 laneKey）。
      const fromLaneKey =
        (event.active.data.current?.laneKey as string | undefined) ?? toLaneKey;

      const verdict = classifyDrag({ fromLaneKey, toLaneKey, fromStatus, toStatus });
      if (verdict === 'none') return;
      if (verdict === 'status') {
        callbacks.onChangeStatus(task.id, toStatus);
        return;
      }
      setPending({ task, payload: { taskId: task.id, fromLaneKey, toLaneKey, fromStatus, toStatus } });
    },
    [callbacks, options],
  );

  const accept = useCallback(() => {
    if (!pending) return;
    const dimension = options.laneDimensions()[pending.payload.toLaneKey] as
      | import('./dimensions').GroupDimensionKey
      | undefined;
    const patch = dimension
      ? patchForLane({ dimension, laneKey: pending.payload.toLaneKey, task: pending.task })
      : {};
    callbacks.onChangeGroup(pending.task.id, patch, {
      status: pending.payload.toStatus !== pending.payload.fromStatus ? pending.payload.toStatus : undefined,
    });
    setPending(null);
  }, [pending, callbacks, options]);

  const cancel = useCallback(() => setPending(null), []);

  const confirmText = useMemo(() => {
    if (!pending) return null;
    const labels = options.laneLabels();
    const from = labels[pending.payload.fromLaneKey] ?? pending.payload.fromLaneKey;
    const to = labels[pending.payload.toLaneKey] ?? pending.payload.toLaneKey;
    const crossStatus = pending.payload.fromStatus !== pending.payload.toStatus;
    // 4.9 文案：主句 + 影响说明。
    return [
      `将任务 ${pending.task.id} 从「${from}」移动到「${to}」？`,
      crossStatus
        ? '这将同时更改任务的分组归属和状态。'
        : '这将同时更改任务的分组归属。',
    ].join('\n');
  }, [pending, options]);

  return { confirm: pending, confirmText, onDragEnd, accept, cancel };
}
