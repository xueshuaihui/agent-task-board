import { useMemo, useRef, useState } from 'react';
import { Network, X } from 'lucide-react';
import { api, qk, useApiMutation } from '@/api';
import type { TaskAggregate, TaskDetail } from '@/api';
import { taskSkillsApi, useSkills } from '@/features/skills';
import { SKILL_TYPE_META } from '@/features/skills/meta';
import { SkillPicker } from '@/features/skills/skill-picker';
import { useTaskOverview } from '@/features/task-detail/queries';
import { SubtasksSection } from '@/features/task-detail/subtasks';
import { CommentsTab } from '@/features/task-detail/tabs/comments';
import type { TaskDetailView, TaskSkillRefView } from '@/features/task-detail/types';
import { InlineError, LoadingBlock, Section } from '@/features/task-detail/ui-bits';
import {
  Badge,
  Button,
  Drawer,
  ErrorCopy,
  Progress,
  StatusDot,
  Tabs,
  Textarea,
  useToast,
  type TabItem,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { priorityText } from '@/lib/labels';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { formatDateTime } from '@/lib/time';
import { openDependencyGraph } from './dependency-graph-modal';
import { useRequirementDrawerStore } from './requirement-store';

/**
 * 需求抽屉（2.md 6.1）：需求（type=需求）的详情视图。
 *
 * 与任务详情抽屉（features/task-detail）并列的第二个抽屉单例，壳层通过
 * `<RequirementDrawerHost />` 挂载（本目录 README），入口调
 * `useRequirementDrawerStore.getState().openRequirement(id)`：
 * - 任务详情概览里的「需求」父摘要行（7.2 面包屑）；
 * - 看板/列表卡片的需求角标（4.8，`requirement-badge.tsx`）；
 * - 拆解完成后结果条上的「查看需求」（B13 泳道下线后原泳道头入口移除，其余入口不变）。
 *
 * Tab：子任务（2.md 6.2）/ 执行规则（#8）/ 依赖图（6.3，复用 features/dependency-graph 的
 * Dialog 能力）/ 活动（评论，复用任务详情的 CommentsTab）。概览内容（描述、进度、基本信息）
 * 压在头部与子任务 Tab 顶部，不单设「概览」页——需求本身没有执行/审核维度，Tab 越少越好找。
 */

type RequirementTab = 'subtasks' | 'rules' | 'graph' | 'activity';

const TAB_ITEMS: readonly TabItem[] = [
  { value: 'subtasks', label: '子任务' },
  { value: 'rules', label: '执行规则' },
  { value: 'graph', label: '依赖图' },
  { value: 'activity', label: '活动' },
];

/** 壳层挂载点：ref 保留末次非空 requirementId，抽屉常驻挂载、用 open 控制开关（退场动画需要 true→false 过渡帧）。 */
export function RequirementDrawerHost() {
  const requirementId = useRequirementDrawerStore((state) => state.requirementId);
  const close = useRequirementDrawerStore((state) => state.closeRequirement);
  const lastRequirementIdRef = useRef<string | null>(null);
  if (requirementId) lastRequirementIdRef.current = requirementId;
  const shownRequirementId = requirementId ?? lastRequirementIdRef.current;
  // 每次真正打开（false→true）递增 key 重挂：Tab 回到「子任务」，与旧的「null→整体卸载」等价。
  const wasOpenRef = useRef(false);
  const sessionRef = useRef(0);
  if (requirementId && !wasOpenRef.current) sessionRef.current += 1;
  wasOpenRef.current = Boolean(requirementId);
  if (!shownRequirementId) return null;
  return (
    <RequirementDrawer
      key={sessionRef.current}
      requirementId={shownRequirementId}
      open={Boolean(requirementId)}
      onClose={close}
    />
  );
}

export interface RequirementDrawerProps {
  requirementId: string;
  /** 受控开关：`false` 时抽屉只播退场，内容仍是末次 id 的那份数据。 */
  open: boolean;
  onClose: () => void;
}

export function RequirementDrawer({ requirementId, open, onClose }: RequirementDrawerProps) {
  const overview = useTaskOverview(requirementId);
  const detail = overview.data;

  if (overview.isPending) {
    return (
      <Drawer open={open} title={`需求 ${requirementId}`} onClose={onClose}>
        <LoadingBlock lines={5} />
      </Drawer>
    );
  }
  if (!detail) {
    return (
      <Drawer open={open} title={`需求 ${requirementId}`} onClose={onClose}>
        {/* 与任务详情抽屉同一口径：有错误就交给 `<ErrorCopy>`（细化文案 + 折叠原文），
            查询没错误（还没发过）才用本地那句。 */}
        <InlineError
          text={overview.error ? <ErrorCopy error={overview.error} /> : '需求详情加载失败'}
        />
      </Drawer>
    );
  }
  return <RequirementDrawerBody key={detail.id} detail={detail} open={open} onClose={onClose} />;
}

function RequirementDrawerBody({
  detail,
  open,
  onClose,
}: {
  /** TaskDetailView：后端详情实际下发 `skills`，基座 TaskDetail 未声明。 */
  detail: TaskDetailView;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<RequirementTab>('subtasks');

  const title = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-code leading-4 text-text-tertiary" data-selectable>
        {detail.id}
      </span>
      <span className="truncate text-section-title text-text-primary">{detail.title}</span>
    </div>
  );

  return (
    <Drawer
      open={open}
      title={title}
      onClose={onClose}
      headerExtra={
        <>
          <RequirementMetaRow detail={detail} />
          <div className="mt-2 border-b border-border px-5 pb-0">
            <Tabs
              variant="underline"
              ariaLabel="需求详情标签页"
              className="border-b-0 px-0"
              value={tab}
              onChange={(value) => setTab(value as RequirementTab)}
              items={TAB_ITEMS.map((item) =>
                item.value === 'subtasks'
                  ? { ...item, count: detail.children?.length, }
                  : item,
              )}
            />
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-1">
          <span className="text-aux text-text-secondary">描述</span>
          <p className="whitespace-pre-wrap text-body text-text-primary">
            {detail.description || '无描述'}
          </p>
        </section>
        {detail.aggregate && detail.aggregate.total > 0 ? (
          <section className="flex flex-col gap-1.5">
            <span className="text-aux text-text-secondary">
              进度：{detail.aggregate.done}/{detail.aggregate.total} 完成
            </span>
            <Progress
              value={Math.round((detail.aggregate.done / detail.aggregate.total) * 100)}
            />
          </section>
        ) : null}

        {tab === 'subtasks' ? (
          <SubtasksSection
            taskId={detail.id}
            items={detail.children ?? []}
            aggregate={detail.aggregate ?? null}
          />
        ) : null}
        {tab === 'rules' ? <ExecutionRulesTab detail={detail} /> : null}
        {tab === 'graph' ? <GraphTab detail={detail} /> : null}
        {tab === 'activity' ? <CommentsTab taskId={detail.id} /> : null}
      </div>
    </Drawer>
  );
}

/**
 * #8 执行规则 Tab：规则与强制技能是两个独立保存动作。
 *
 * - 规则：`PATCH /tasks/{id} {execution_rules}`，空串归一为 null；成功失效任务根 +
 *   board/tasks 前缀（与 SkillsTab 同口径）。
 * - 技能：复用既有 `tasks.skills` 绑定，写 `taskSkillsApi.set`（全量提交）。
 * - 技能列表挂了只降级技能区，规则仍可编辑（tier-2）。
 */
function ExecutionRulesTab({ detail }: { detail: TaskDetailView }) {
  const toast = useToast();
  const allSkills = useSkills();
  const [rules, setRules] = useState(detail.execution_rules ?? '');

  const bound = useMemo(() => detail.skills ?? [], [detail.skills]);
  const boundIds = useMemo(() => new Set(bound.map((ref) => ref.skill_id)), [bound]);
  const byId = useMemo(
    () => new Map((allSkills.data?.items ?? []).map((skill) => [skill.id, skill])),
    [allSkills.data?.items],
  );
  const candidates = useMemo(
    () =>
      (allSkills.data?.items ?? []).filter(
        (skill) => skill.status !== 'ARCHIVED' && !boundIds.has(skill.id),
      ),
    [allSkills.data?.items, boundIds],
  );

  const saveRules = useApiMutation(
    (value: string | null) => api.tasks.patch(detail.id, { execution_rules: value }),
    {
      invalidate: () => [qk.taskRoot(detail.id), qk.boardRoot, qk.tasksRoot],
      onSuccess: (updated) => {
        setRules(updated.execution_rules ?? '');
        toast.success('执行规则已保存');
      },
    },
  );

  const setSkills = useApiMutation(
    (refs: TaskSkillRefView[]) =>
      taskSkillsApi.set(
        detail.id,
        refs.map((ref) => ({ skill_id: ref.skill_id, version: ref.version ?? undefined })),
      ),
    {
      invalidate: () => [qk.taskRoot(detail.id), qk.boardRoot, qk.tasksRoot],
      onSuccess: () => toast.success('强制技能已更新'),
    },
  );

  const dirty = rules !== (detail.execution_rules ?? '');

  const saveRulesNow = () => {
    if (saveRules.isPending) return;
    saveRules.mutate(rules.trim() === '' ? null : rules);
  };

  const bind = (skillId: string) => {
    if (setSkills.isPending) return;
    setSkills.mutate([...bound, { skill_id: skillId }]);
  };

  const unbind = (skillId: string) => {
    if (setSkills.isPending) return;
    setSkills.mutate(bound.filter((ref) => ref.skill_id !== skillId));
  };

  return (
    <div className="flex flex-col gap-5">
      <Section title="执行规则" meta={`${rules.length} / 20000 字`}>
        <p className="text-aux text-text-secondary">
          规则会随子任务被 Agent 领取时注入并冻结快照；v1 为软强制（不阻断领取），运行中修改只影响下一次领取。
        </p>
        <Textarea
          aria-label="需求执行规则"
          rows={10}
          maxLength={20000}
          value={rules}
          placeholder="例如：所有子任务必须先补测试；禁止修改 CI 配置…"
          onChange={(event) => setRules(event.target.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-aux text-text-tertiary">
            最后更新：
            {detail.execution_rules_updated_at
              ? formatDateTime(detail.execution_rules_updated_at)
              : '尚未设置'}
          </span>
          <Button
            size="sm"
            variant="primary"
            loading={saveRules.isPending}
            disabled={!dirty || saveRules.isPending}
            onClick={saveRulesNow}
          >
            保存规则
          </Button>
        </div>
        {saveRules.isError ? <InlineError text={<ErrorCopy error={saveRules.error} />} /> : null}
      </Section>

      <Section title="强制技能" meta={bound.length > 0 ? `(${bound.length})` : undefined}>
        <p className="text-aux text-text-secondary">
          这些技能会随需求强制注入子任务执行，领取时快照；运行中修改只影响下一次领取。
        </p>

        {allSkills.isPending ? (
          <LoadingBlock lines={4} />
        ) : allSkills.isError ? (
          <InlineError text={<ErrorCopy error={allSkills.error} />} />
        ) : (
          <>
            {bound.length === 0 ? (
              <p className="text-aux text-text-tertiary">尚未绑定强制技能。</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {bound.map((ref) => {
                  const skill = byId.get(ref.skill_id);
                  return (
                    <li key={ref.skill_id} className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-body text-text-primary">
                        {skill?.name ?? ref.skill_id}
                        <span className="ml-2 font-mono text-aux text-text-tertiary">
                          {ref.version ?? skill?.current_version ?? '—'}
                        </span>
                      </span>
                      {skill ? (
                        <Badge tone="outline">
                          {SKILL_TYPE_META[skill.type]?.label ?? skill.type}
                        </Badge>
                      ) : null}
                      <Button
                        size="iconSm"
                        variant="ghost"
                        aria-label={`解绑 ${skill?.name ?? ref.skill_id}`}
                        icon={<X className="size-3.5" />}
                        disabled={setSkills.isPending}
                        onClick={() => unbind(ref.skill_id)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {setSkills.isError ? <InlineError text={<ErrorCopy error={setSkills.error} />} /> : null}
            <SkillPicker
              candidates={candidates}
              multiple
              selectedIds={bound.map((ref) => ref.skill_id)}
              onSelect={(skill) => bind(skill.id)}
              placeholder="搜索技能（名称 / 分类 / 类型 / 标签 / ID，草稿与已发布）"
              emptyText="没有可绑定的技能"
              ariaLabel="强制技能候选"
            />
          </>
        )}
      </Section>
    </div>
  );
}

/**
 * 6.1 头部：需求徽标、优先级、聚合状态、聚合进度条。
 *
 * §19.14·86（v0.0.4 W2-b）：「分组」MetaCell 已删——看板可见面上 Group 概念整体
 * 下线、需求即归属，「需求属于哪个分组」不再有展示价值（group_id 仍是数据真值，
 * 只是不再作为 UI 归属入口）。
 */
function RequirementMetaRow({ detail }: { detail: TaskDetail }) {
  const priority = priorityStyle(detail.priority);
  const aggregate = detail.aggregate;
  const aggregateView = aggregate
    ? AGGREGATE_VIEW[aggregate.status] ?? AGGREGATE_VIEW.IN_PROGRESS
    : null;
  const aggregateStyle = aggregateView ? statusStyle(aggregateView.status) : null;
  const percent = aggregate && aggregate.total > 0 ? Math.round((aggregate.done / aggregate.total) * 100) : null;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 px-5 pt-2 text-aux">
      <MetaCell label="类型">
        <Badge tone="neutral">需求</Badge>
      </MetaCell>
      <MetaCell label="优先级">
        <StatusDot className={priority.dot} />
        <span className={cn('font-medium', priority.text)}>{priorityText(detail.priority)}</span>
      </MetaCell>
      <MetaCell label="聚合状态">
        {aggregateView && aggregateStyle ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot className={aggregateStyle.dot} />
            <span className={cn('font-medium', aggregateStyle.text)}>{aggregateView.label}</span>
          </span>
        ) : (
          <span className="text-text-tertiary">暂无子任务</span>
        )}
      </MetaCell>
      {percent !== null ? (
        <MetaCell label="聚合进度" className="col-span-2">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Progress value={percent} className="flex-1" />
            <span className="shrink-0 font-medium tabular-nums text-text-primary">
              {aggregate?.done}/{aggregate?.total}
            </span>
          </span>
        </MetaCell>
      ) : null}
    </div>
  );
}

/** 6.3：Tab 内不开第二个抽屉——给入口卡，点按用全局 `openDependencyGraph` 弹依赖图。 */
function GraphTab({ detail }: { detail: TaskDetail }) {
  const children = detail.children ?? [];
  const graphTasks = children.map((child) => ({
    id: child.id,
    title: child.title,
    status: child.status,
    priority: child.priority,
    progress: null,
    // 让 DependencyGraphDialog 的 requirementId 过滤生效（GraphTask.requirement_id）。
    requirement_id: detail.id,
  }));

  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-bg-surface p-4">
      <p className="text-body text-text-primary">查看这 {children.length} 个子任务之间的阻塞 / 关联关系。</p>
      <p className="text-aux text-text-tertiary">
        依赖是子任务级别的（1.md 5.3：子任务独立依赖关系）；在图里点击节点打开子任务详情、点击边删除依赖。
      </p>
      <div>
        <Button
          variant="primary"
          size="sm"
          icon={<Network className="size-3.5" aria-hidden />}
          disabled={children.length === 0}
          onClick={() => openDependencyGraph(graphTasks, detail.id)}
        >
          打开依赖图
        </Button>
      </div>
      {children.length === 0 ? (
        <p className="text-aux text-text-tertiary">还没有子任务，先在「子任务」里拆分。</p>
      ) : null}
    </div>
  );
}

function MetaCell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <span className="shrink-0 text-text-secondary">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-text-primary">{children}</span>
    </div>
  );
}

/** 聚合状态 → 展示文案与样式（与 task-detail/subtasks.tsx 同一张映射，两处都是 UI 视图，不共享以免互相牵动）。 */
const AGGREGATE_VIEW: Record<TaskAggregate['status'], { label: string; status: 'DONE' | 'BACKLOG' | 'RUNNING' }> = {
  DONE: { label: '已完成', status: 'DONE' },
  BACKLOG: { label: '未开始', status: 'BACKLOG' },
  IN_PROGRESS: { label: '进行中', status: 'RUNNING' },
};
