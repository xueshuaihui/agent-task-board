import { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { FieldDef, TaskPatchInput } from '@/api/types';
import { errorMessage } from '@/api';
import { useShellStore } from '@/app/store/shell';
import { Button, Dialog, useToast } from '@/components/ui';
import { useGroupMutations, useGroups } from '@/features/groups';
import type { CardActions } from './card-actions';
import { FLY_DROP_SUPPRESS_MS, suppressFly } from './fly-motion';
import type { BoardMutations } from './mutations';
import { SwimlaneView } from './grouping/Swimlane';
import { ArchivedGroupsSection } from './grouping/ArchivedGroupsSection';
import { GroupMoreMenu } from './grouping/GroupMoreMenu';
import { useCrossGroupDrag } from './grouping/useCrossGroupDrag';
import { toGroupable, type GroupableTask } from './grouping/dimensions';
import {
  applyLaneOrder,
  buildSwimlanes,
  filterLanes,
  type Swimlane,
} from './grouping/grouping';
import { isLaneCollapsed, useGroupingStore } from './grouping/useGroupingState';
import { BoardCardView } from './task-card-view';
import type { RunOverlay } from './use-run-overlay';

/**
 * 分组（泳道）模式下的看板主体：数据拉平已在 `BoardPage` 完成，这里只负责——
 * - 泳道渲染（`SwimlaneView` + `GroupMoreMenu`）与泳道头拖拽排序（7.6）；
 * - 跨分组拖拽确认（4.9）：同一 DndContext 里按 active id 前缀分流
 *   （`lane:` → 泳道排序，`task:` → `useCrossGroupDrag`）；
 * - 归属补丁翻译：`patchForLane` 的接缝字段 → 服务端 `PATCH /tasks/:id` 字段。
 */
export interface GroupedBoardProps {
  /** 已按多分组偏好过滤过的卡片。 */
  tasks: readonly GroupableTask[];
  defs: readonly FieldDef[];
  actions: CardActions;
  mutations: BoardMutations;
  overlayOf: (id: string) => RunOverlay;
}

export function GroupedBoard({ tasks, defs, actions, mutations, overlayOf }: GroupedBoardProps) {
  const toast = useToast();
  const primary = useGroupingStore((state) => state.primary);
  const secondary = useGroupingStore((state) => state.secondary);
  const options = useGroupingStore((state) => state.options);
  const laneOrder = useGroupingStore((state) => state.laneOrder);
  const laneFilter = useGroupingStore((state) => state.laneFilter);
  const laneSort = useGroupingStore((state) => state.laneSort);
  const collapsed = useGroupingStore((state) => state.collapsed);
  const setLaneOrder = useGroupingStore((state) => state.setLaneOrder);
  const toggleLaneCollapsed = useGroupingStore((state) => state.toggleLaneCollapsed);

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  /* --------------------------------------------------- 分组缓存（W4 徽标/归档） */

  const groupsQuery = useGroups();
  const groupById = useMemo(
    () => new Map((groupsQuery.data?.items ?? []).map((group) => [group.id, group])),
    [groupsQuery.data?.items],
  );
  const groupMutations = useGroupMutations();

  /* ------------------------------------------------------------- 泳道构建 */

  const lanes = useMemo(() => {
    // 4.10「组内排序」：在进分组引擎前排一次，泳道内的列内顺序不受影响。
    const sorted = [...tasks];
    if (laneSort === 'priority') sorted.sort((a, b) => a.priority - b.priority);
    else if (laneSort === 'updated_at')
      sorted.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    let built = buildSwimlanes({
      tasks: sorted,
      primary,
      secondary,
      showEmptyLanes: options.showEmptyLanes,
    });
    if (options.rememberOrder) built = applyLaneOrder(built, laneOrder[primary] ?? []);
    let result = filterLanes(built, laneFilter);
    if (primary === 'group') {
      // v0.0.4 W4 §6.2.2：分组维度用分组缓存装饰泳道头——「默认 / 已归档」小徽标。
      // 「已归档」只出现在显式选中归档组的场合（默认看板数据已在服务端排除）。
      result = result.map((lane) => {
        const group = groupById.get(lane.key);
        if (!group) return lane;
        return {
          ...lane,
          headBadge:
            group.status === 'ARCHIVED' ? '已归档' : group.is_default === 1 ? '默认' : undefined,
        };
      });
      // §6.2.2 / 验收 75 口径：默认分组泳道固定排在最后（用户记忆顺序只作用于其余泳道）。
      const isDefaultLane = (lane: Swimlane) => groupById.get(lane.key)?.is_default === 1;
      result = [...result.filter((lane) => !isDefaultLane(lane)), ...result.filter(isDefaultLane)];
    }
    return result;
  }, [tasks, primary, secondary, options, laneOrder, laneFilter, laneSort, groupById]);

  const laneItems = useMemo(() => lanes.map((lane) => `lane:${lane.key}`), [lanes]);

  /* ------------------------------------------------------- 跨分组拖拽接线 */

  const laneLabels = useCallback(
    () => Object.fromEntries(lanes.map((lane) => [lane.key, lane.label])),
    [lanes],
  );
  const laneDimensions = useCallback(
    () => Object.fromEntries(lanes.map((lane) => [lane.key, lane.dimension])),
    [lanes],
  );

  /**
   * `patchForLane` 的接缝字段 → 服务端 PATCH 字段（apps/api/src/contract/schemas.ts 的
   * `taskPatchSchema`：group_id / priority / tags / type 可写；parent_task_id 与
   * agent 不在白名单，跨需求 / 跨 Agent 移动暂不开放，走 Toast 提示）。
   */
  const onChangeGroup = useCallback(
    (taskId: string, patch: Record<string, unknown>, to?: { status?: import('@/api/types').TaskStatus }) => {
      const task = tasksRef.current.find((item) => item.id === taskId);
      if (!task) return;
      const body: Record<string, unknown> = {};
      let blocked: string | null = null;
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'group_id') body.group_id = value;
        else if (key === 'priority') body.priority = value;
        else if (key === 'type') body.type = value;
        else if (key === 'requirement_id') blocked = '跨需求移动（父子关系调整）暂未开放';
        else if (key === 'agent_name') blocked = '跨 Agent 移动暂未开放';
        else if (key === 'tag') {
          const tag = String(value ?? '');
          if (tag === '__unassigned__') blocked = '暂不支持把任务移出标签（无法定位要移除的标签）';
          else if (tag && !task.tags.includes(tag)) body.tags = [...task.tags, tag];
        }
      }
      if (blocked) {
        toast.warning('暂未开放', blocked);
        return;
      }
      if (Object.keys(body).length > 0) {
        mutations.patch.mutate(
          { id: taskId, body: body as TaskPatchInput },
          { onError: (error) => toast.error('分组移动失败', errorMessage(error)) },
        );
      }
      if (to?.status && to.status !== task.status) actions.move(task, to.status);
    },
    [actions, mutations, toast],
  );

  const onChangeStatus = useCallback(
    (taskId: string, status: import('@/api/types').TaskStatus) => {
      const task = tasksRef.current.find((item) => item.id === taskId);
      if (task) actions.move(task, status);
    },
    [actions],
  );

  const cross = useCrossGroupDrag({
    callbacks: { onChangeGroup, onChangeStatus },
    laneLabels,
    laneDimensions,
    tasks: () => tasksRef.current,
  });

  /* ----------------------------------------------------------- DndContext */

  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const clearDrag = useCallback(() => setActiveTaskId(null), []);

  const onDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith('task:')) setActiveTaskId(id.slice('task:'.length));
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const id = String(event.active.id);
      clearDrag();
      if (id.startsWith('lane:')) {
        const overId = event.over ? String(event.over.id) : null;
        if (!overId || !overId.startsWith('lane:') || overId === id) return;
        const keys = lanes.map((lane) => lane.key);
        const from = keys.indexOf(id.slice('lane:'.length));
        const to = keys.indexOf(overId.slice('lane:'.length));
        if (from < 0 || to < 0 || from === to) return;
        setLaneOrder(primary, arrayMove(keys, from, to));
        return;
      }
      if (id.startsWith('task:')) {
        // §5.2 规则 5：泳道模式拖拽源同样写抑制名单，覆盖与经典视图完全相同的
        // dropAnimation 同帧窗口（210ms），block-move 确认弹窗后的 `actions.move`
        // 不在抑制期内——那是拖拽早已落定的独立用户确认，按 direct 路径参与飞行。
        suppressFly(id.slice('task:'.length), FLY_DROP_SUPPRESS_MS);
        cross.onDragEnd(event);
      }
    },
    [clearDrag, cross, lanes, primary, setLaneOrder],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const activeCard = activeTaskId ? tasks.find((task) => task.id === activeTaskId) : undefined;

  /* --------------------------------------------------------------- 动作 */

  const laneTasks = (lane: Swimlane): GroupableTask[] =>
    lane.groups.flatMap((group) => group.columns.flatMap((column) => column.tasks));

  const archiveDone = useCallback(
    (lane: Swimlane) => {
      const done = laneTasks(lane).filter((task) => task.status === 'DONE');
      if (done.length === 0) {
        toast.info('没有可归档任务', `分组「${lane.label}」里没有已完成任务`);
        return;
      }
      for (const task of done) mutations.archive.mutate(task.id);
      toast.success('归档已提交', `分组「${lane.label}」共 ${done.length} 个已完成任务`);
    },
    [mutations, toast],
  );

  const openRequirement = useCallback((lane: Swimlane) => {
    if (lane.key === '__unassigned__') return;
    useShellStore.getState().openTask(lane.key);
  }, []);

  /**
   * §5.6 泳道头「归档分组」菜单项（仅分组维度泳道）：
   * 默认分组 / 已归档 / 非分组泳道（未分类）不出现该项；组内还有未完成任务时置灰
   * 并提示剩余数——剩余数以服务端 `unfinished_count` 为准（看板筛选可能藏掉任务，
   * 泳道计数只作缓存缺数时的兜底）；真按了但服务端判不过，409 走默认 Toast。
   */
  const archiveGroupOf = useCallback(
    (lane: Swimlane) => {
      if (lane.dimension !== 'group') return undefined;
      const group = groupById.get(lane.key);
      if (!group || group.is_default === 1 || group.status === 'ARCHIVED') return undefined;
      const remaining =
        group.unfinished_count ??
        laneTasks(lane).filter((task) => task.status !== 'DONE').length;
      return {
        disabled: remaining > 0,
        hint: remaining > 0 ? `还剩 ${remaining} 个` : undefined,
        onSelect: () => groupMutations.archive.mutate(group.id),
      };
    },
    // laneTasks 是每次渲染重建的纯读函数，不进依赖（与上方 archiveDone 同一处理）。
    [groupById, groupMutations],
  );

  /* --------------------------------------------------------------- 渲染 */

  if (lanes.length === 0) {
    return (
      <div className="atb-scroll flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto pt-3">
        <p className="text-body text-text-tertiary">当前分组与筛选下没有泳道</p>
        {/* 任务全在归档分组时会走到这里——折叠区仍出现，查看/恢复入口不能藏（§5.6）。 */}
        {primary === 'group' ? (
          <div className="w-full">
            <ArchivedGroupsSection />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="atb-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2 pt-3">
      <DndContext
        sensors={sensors}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={clearDrag}
      >
        <SortableContext items={laneItems} strategy={verticalListSortingStrategy}>
          {lanes.map((lane) => {
            const isCollapsed = isLaneCollapsed(collapsed, primary, lane.key);
            return (
              <SwimlaneView
                key={lane.key}
                lane={lane}
                collapsed={isCollapsed}
                options={options}
                onToggleCollapse={() => toggleLaneCollapsed(primary, lane.key, !isCollapsed)}
                moreMenu={
                  <GroupMoreMenu
                    laneKey={lane.key}
                    laneLabel={lane.label}
                    dimension={lane.dimension}
                    collapsed={isCollapsed}
                    laneKeys={laneItems.map((item) => item.slice('lane:'.length))}
                    onExport={() => toast.info('暂未开放', '分组导出能力将在后续版本提供')}
                    onArchiveDone={() => archiveDone(lane)}
                    archiveGroup={archiveGroupOf(lane)}
                  />
                }
                onViewRequirement={lane.dimension === 'requirement' ? () => openRequirement(lane) : undefined}
                renderCard={(task) => (
                  <GroupedCard
                    task={task}
                    laneKey={lane.key}
                    defs={defs}
                    overlay={overlayOf(task.id)}
                    actions={actions}
                  />
                )}
              />
            );
          })}
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {activeCard ? (
            <BoardCardView
              card={toGroupable(activeCard)}
              defs={defs}
              overlay={overlayOf(activeCard.id)}
              actions={actions}
              asOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* v0.0.4 W4 §5.6 / §6.2.2：归档分组折叠区（折叠态 + 计数 + 查看 / 恢复），仅分组维度。 */}
      {primary === 'group' ? <ArchivedGroupsSection /> : null}

      {/* 4.9 跨分组拖拽确认（现有 Dialog）：确认才发归属 / 流转请求。 */}
      <Dialog
        open={cross.confirm !== null}
        onClose={cross.cancel}
        title="跨分组移动任务"
        footer={
          <>
            <Button variant="ghost" onClick={cross.cancel}>
              取消
            </Button>
            <Button variant="primary" onClick={cross.accept}>
              确认移动
            </Button>
          </>
        }
      >
        <p className="whitespace-pre-line text-body text-text-secondary">{cross.confirmText}</p>
      </Dialog>
    </div>
  );
}

/**
 * 分组模式下的卡片拖拽外壳：dnd id 用 `task:{id}`（useCrossGroupDrag 的解析约定），
 * `data.laneKey` 带来源泳道，是「跨分组」判定的依据。卡片渲染复用 BoardCardView。
 */
function GroupedCard({
  task,
  laneKey,
  defs,
  overlay,
  actions,
}: {
  task: GroupableTask;
  laneKey: string;
  defs: readonly FieldDef[];
  overlay: RunOverlay;
  actions: CardActions;
}) {
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `task:${task.id}`,
    data: { laneKey, status: task.status, id: task.id },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      {...listeners}
      className={isDragging ? 'opacity-40' : undefined}
    >
      <BoardCardView card={task} defs={defs} overlay={overlay} actions={actions} />
    </div>
  );
}
