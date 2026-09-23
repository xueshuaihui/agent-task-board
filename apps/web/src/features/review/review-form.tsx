import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useReducedMotion, motion } from 'motion/react';
import { FileCode2, AlertTriangle, RotateCcw } from 'lucide-react';
import {
  api,
  errorMessage,
  fieldErrorsOf,
  isApiError,
  qk,
  useApiMutation,
  useSettings,
  useTaskOverview,
} from '@/api';
import type { ReviewConclusion, ReviewInput, RunArtifact } from '@/api/types';
import type { ReviewPrefill } from '@/app/store/shell';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  Field,
  RadioGroup,
  Select,
  StatusDot,
  Textarea,
  useToast,
} from '@/components/ui';
import { transitions } from '@/lib/motion';
import {
  ARTIFACT_TYPE_LABEL,
  REVIEW_CONCLUSION_LABEL,
  RUN_STATUS_LABEL,
  TRIGGER_TYPE_LABEL,
  labelOf,
  priorityText,
  statusLabel,
} from '@/lib/labels';
import { ArtifactList } from '@/features/task-detail/artifacts/artifact-list';
import { ArtifactPreviewDialog } from '@/features/task-detail/artifacts/preview-dialog';
import { DiffViewer } from '@/features/task-detail/artifacts/diff-viewer';
import { downloadArtifact } from '@/features/task-detail/artifacts/use-artifact-content';
import type { PreviewTarget } from '@/features/task-detail/types';
import { Mono } from '@/features/task-detail/ui-bits';
import { priorityStyle, statusStyle } from '@/lib/status-style';
import { formatBytes, formatDateTime, formatDuration, formatRelative } from '@/lib/time';
import {
  EMPTY_DRAFT,
  REVIEW_FIELD_MAX,
  clearDraft,
  clampField,
  missingRequiredFields,
  readDraft,
  writeDraft,
  type RequiredField,
  type ReviewDraft,
} from './drafts';
import { notifyReviewSubmitted } from './queue';
import { artifactsSourceRun, lastReview, reviewHistory, reviewTargetRun, useTaskReviews, useTaskRuns } from './queries';

/**
 * 6.5 / 8.4 审核表单。原型 5.3：与审核页右栏是「同一组件、两处外壳」——
 * 本文件只实现 720px 模态这一壳，审核页内嵌那壳由 `review-page.tsx` 复用同一套字段块。
 */
export interface ReviewFormDialogProps {
  taskId: string | null;
  /** 入口带来的预填（PRD 4.5 末段 / 原型 3.7、4.9）：只覆盖结论与退回目标，三字段仍必填。 */
  prefill?: ReviewPrefill | null;
  onClose: () => void;
}

/** 退场动画接线：`taskId` 变 null 不卸载——ref 保留末次非空 id，Dialog 用 open 受控播 140ms 退场。 */
export function ReviewFormDialog({ taskId, prefill, onClose }: ReviewFormDialogProps) {
  const lastTaskIdRef = useRef<string | null>(null);
  if (taskId) lastTaskIdRef.current = taskId;
  const shownTaskId = taskId ?? lastTaskIdRef.current;
  // 每次真正打开（false→true）递增 key 重挂表单：草稿、错误、滚动位置不跨次残留（与旧卸载语义等价）。
  const wasOpenRef = useRef(false);
  const sessionRef = useRef(0);
  if (taskId && !wasOpenRef.current) sessionRef.current += 1;
  wasOpenRef.current = Boolean(taskId);
  if (!shownTaskId) return null;
  // 换任务等于换表单：key 带会话号 + 任务 id，草稿、错误、滚动位置都不该跨任务残留（key 让整棵子树重建）。
  return (
    <ReviewFormBody
      key={`${sessionRef.current}:${shownTaskId}`}
      taskId={shownTaskId}
      open={Boolean(taskId)}
      prefill={prefill}
      onClose={onClose}
    />
  );
}

/** 预填只动两个单选项：通过时无「退回目标」（原型 5.3 字段可见性行），故按存在与否合并。 */
function applyPrefill(draft: ReviewDraft, prefill: ReviewPrefill | null | undefined): ReviewDraft {
  if (!prefill) return draft;
  return {
    ...draft,
    ...(prefill.conclusion ? { conclusion: prefill.conclusion } : {}),
    ...(prefill.returnTo ? { returnTo: prefill.returnTo } : {}),
  };
}

function ReviewFormBody({
  taskId,
  open,
  prefill,
  onClose,
}: {
  taskId: string;
  open: boolean;
  prefill?: ReviewPrefill | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const overview = useTaskOverview(taskId);
  const runs = useTaskRuns(taskId);
  const reviews = useTaskReviews(taskId);
  const settings = useSettings();
  /** DESIGN §1.6：系统开启「减少动态效果」时退回字段不做位移入场。 */
  const reduceMotion = useReducedMotion();

  const [draft, setDraft] = useState<ReviewDraft>(() =>
    applyPrefill(readDraft(taskId) ?? EMPTY_DRAFT, prefill),
  );
  const [localErrors, setLocalErrors] = useState<Partial<Record<RequiredField, string>>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [truncated, setTruncated] = useState<Partial<Record<RequiredField, boolean>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  /** 原型 5.3 上半区的产物预览框：`link` 不进这里，它走系统默认浏览器（6.10.1）。 */
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const suggestionRef = useRef<HTMLTextAreaElement>(null);
  const reusedRef = useRef(Boolean(readDraft(taskId)));
  const appliedPrefill = useRef<ReviewPrefill | null>(prefill ?? null);

  /* ---------------------------------------------------------- 草稿与预填 */

  // 表单已经开着、又从另一个入口打开同一个任务（队列跳下一条 ↔ 看板拖拽）：预填要跟着换。
  useEffect(() => {
    if (appliedPrefill.current === (prefill ?? null)) return;
    appliedPrefill.current = prefill ?? null;
    setDraft((current) => applyPrefill(current, prefill));
  }, [prefill]);

  // 6.5 第 5 条：草稿按任务存内存，切走再回来不丢。
  useEffect(() => {
    writeDraft(taskId, draft);
  }, [taskId, draft]);

  const reuseEnabled = settings.data?.review_reuse_last_opinion ?? true;
  const previous = lastReview(reviews.data?.items);

  // 打开表单时预填上一次审核的三字段（20.9 `review_reuse_last_opinion`，默认开）。
  // 设置先落地再判：否则「关了复用」的库会在 reviews 先到时被抓一次空填。
  useEffect(() => {
    if (reusedRef.current || settings.isPending || !reuseEnabled || !reviews.data) return;
    reusedRef.current = true;
    const last = lastReview(reviews.data.items);
    if (!last) return;
    setDraft((current) => ({
      ...current,
      suggestion: current.suggestion || last.suggestion,
      reason: current.reason || last.reason,
      detail: current.detail || last.detail,
    }));
    // 预填后聚焦「建议」，用户从第一个必填项开始改；只抢一次，不打断后续输入。
    window.requestAnimationFrame(() => suggestionRef.current?.focus());
  }, [reviews.data, reuseEnabled, settings.isPending]);

  /* ---------------------------------------------------------------- 提交 */

  const submit = useApiMutation<ReviewInput, unknown>(
    (body) => api.tasks.review(taskId, body),
    {
      // 基座约定：失效走 mutation 的 invalidate，前缀覆盖看板 / 本页表格 / 抽屉 / 铃铛角标。
      invalidate: () => [
        qk.boardRoot,
        qk.tasksRoot,
        qk.taskRoot(taskId),
        qk.notificationsRoot,
      ],
      // 错误一律在表单内联回显（原型 5.3 的「顶部条幅」+ 逐字段红字），不另弹 Toast。
      toastOnError: false,
      onSuccess: () => {
        clearDraft(taskId);
        toast.success(
          `已提交审核：${draft.conclusion === 'APPROVE' ? '通过' : '驳回'}`,
          `${taskId} · 审核记录已保留，Agent 下次领取可读`,
        );
        // 先关再通知：审核页的「跳到下一条」是往同一个 store 字段里写新 id，
        // 顺序反了就会被随后的 onClose() 清空。
        onClose();
        notifyReviewSubmitted(taskId);
      },
      // `useApiMutation` 只暴露 onSettled（10.4 的失败回显口径），错误分支挂在这里。
      onSettled: (_data, error) => {
        if (!error) return;
        const code = isApiError(error) ? error.code : null;
        if (code === 'VALIDATION_FAILED') {
          setServerErrors(fieldErrorsOf(error));
          setBanner('有字段未通过服务端校验，见下方红字');
          return;
        }
        setServerErrors({});
        // 4.5 / 原型 5.3：并发来源把任务拖走时不清空表单，改成顶部条幅 + 刷新后重试。
        if (code === 'ILLEGAL_TRANSITION' || code === 'TASK_GONE' || code === 'NOT_FOUND') {
          setBanner('该任务状态已变化');
          return;
        }
        setBanner(errorMessage(error));
      },
    },
  );

  const patch = useCallback((next: Partial<ReviewDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const setField = useCallback((key: RequiredField, raw: string) => {
    const clamped = clampField(raw);
    if (clamped.truncated) setTruncated((current) => ({ ...current, [key]: true }));
    setDraft((current) => ({ ...current, [key]: clamped.value }));
    if (raw.trim().length > 0) setLocalErrors((current) => ({ ...current, [key]: undefined }));
    setServerErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const onSubmit = useCallback(() => {
    const missing = missingRequiredFields(draft);
    setLocalErrors(
      Object.fromEntries(
        missing.map((key) => [key, FIELD_LABEL[key] ? `请填写${FIELD_LABEL[key]}` : '必填']),
      ) as Partial<Record<RequiredField, string>>,
    );
    if (missing.length > 0) {
      setBanner(null);
      return;
    }
    setBanner(null);
    // 4.3 / 6.5：通过与驳回都带三字段；退回目标与优先级调整只随驳回发出
    //（服务端 `reviewSchema` 对「通过时带 return_to」直接 422）。
    const body: ReviewInput = {
      conclusion: draft.conclusion,
      suggestion: draft.suggestion.trim(),
      reason: draft.reason.trim(),
      detail: draft.detail.trim(),
      ...(draft.conclusion === 'REJECT'
        ? {
            return_to: draft.returnTo,
            ...(draft.priorityAdj === undefined ? {} : { priority_adj: draft.priorityAdj }),
          }
        : {}),
    };
    submit.mutate(body);
  }, [draft, submit]);

  // 6.5 第 5 条：⌘/Ctrl + Enter 提交。
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (!submit.isPending) void onSubmit();
    },
    [onSubmit, submit.isPending],
  );

  /* ---------------------------------------------------------------- 展示 */

  const task = overview.data;
  const run = reviewTargetRun(runs.data?.items, task?.current_run_id);
  const history = reviewHistory(reviews.data?.items);
  const status = task?.status ?? 'REVIEW';
  const offQueue = status !== 'REVIEW';

  // 6.10.3 的上限走同一个设置项（20.9），与详情抽屉一致，审核表单不自立第二口径。
  const maxMb = settings.data?.artifact_max_mb ?? 20;
  // B8：目标 Run 无产物时回退到最近一次有产物的 Run，展示层标注归属，不空屏。
  const artifactRun = artifactsSourceRun(runs.data?.items, run);
  const artifacts = artifactRun?.artifacts ?? [];
  // 原型 5.3：`diff` 类单独成块内嵌预览，其余进「其他产物」行（下载 / 浏览器打开 / 预览）。
  const diffArtifacts = artifacts.filter((item) => item.type === 'diff');
  const otherArtifacts = artifacts.filter((item) => item.type !== 'diff');

  const dialogTitle = task ? `审核 ${task.id} ${task.title}` : `审核 ${taskId}`;

  const conclusionCopy = useMemo(() => {
    if (draft.conclusion === 'APPROVE') return '通过后任务进入「已完成」。';
    return `驳回后任务退回「${statusLabel(draft.returnTo)}」，可继续执行。`;
  }, [draft.conclusion, draft.returnTo]);

  return (
    <Dialog
      open={open}
      size="review"
      title={dialogTitle}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <span className="mr-auto text-aux text-text-tertiary">
            {banner ? null : '⌘ / Ctrl + Enter 提交'}
          </span>
          <Button onClick={onClose}>取消</Button>
          {/* DESIGN §4 审核：结论即强调——通过走 primary 渐变，驳回切换 outlineDanger 描红。 */}
          <Button
            variant={draft.conclusion === 'REJECT' ? 'outlineDanger' : 'primary'}
            loading={submit.isPending}
            disabled={offQueue}
            onClick={onSubmit}
          >
            提交审核
          </Button>
        </div>
      }
    >
      <div onKeyDown={onKeyDown} className="flex flex-col gap-4">
        {banner ? (
          <StaleBanner
            text={banner}
            onRetry={() => {
              setBanner(null);
              setServerErrors({});
              void overview.refetch();
              void runs.refetch();
              void reviews.refetch();
            }}
          />
        ) : null}
        {offQueue ? (
          <StaleBanner
            text={`该任务当前不在待审核列（${task ? statusLabel(task.status) : '加载中'}），审核记录只增不改不删，请刷新后确认`}
            onRetry={() => void overview.refetch()}
          />
        ) : null}

        {/* DESIGN §4 审核：表单顶部摘要头卡片——任务元信息 + 本次执行摘要收进同一张卡，
            状态徽标升到卡头右侧；文案与加载/错误分支保持原样。 */}
        <Card>
          <CardHeader className="justify-between text-card-title">
            <span className="text-card-title text-text-primary">任务信息</span>
            {task ? (
              <Badge className="flex items-center gap-1">
                <StatusDot className={statusStyle(status).dot} />
                {task.status_label || statusLabel(status)}
              </Badge>
            ) : null}
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            {overview.isPending ? (
              <p className="text-aux text-text-tertiary">加载中…</p>
            ) : task ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-code text-text-secondary" data-selectable>
                    {task.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-card-title text-text-primary">
                    {task.title}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-aux text-text-secondary">
                  <Badge tone="neutral">{task.type}</Badge>
                  <Badge className={priorityStyle(task.priority).soft}>
                    {priorityText(task.priority)}
                  </Badge>
                  {task.tags.map((tag) => (
                    <Badge key={tag} tone="outline">
                      {tag}
                    </Badge>
                  ))}
                  <span>第 {task.run_count} 次执行</span>
                  {run?.agent_name ? <span>Agent：{run.agent_name}</span> : null}
                </div>
              </div>
            ) : (
              <p className="text-aux text-status-failed">{errorMessage(overview.error)}</p>
            )}
            <Section title="执行摘要">
              {run ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mono className="shrink-0">{run.id}</Mono>
                    <Badge tone="neutral">{run.agent_name ?? '未署名 Agent'}</Badge>
                    <Badge className={RUN_STATUS_SOFT[run.status] ?? ''}>
                      {labelOf(RUN_STATUS_LABEL, run.status)}
                    </Badge>
                    <span className="text-aux text-text-tertiary">
                      {formatDateTime(run.started_at)}
                      {run.finished_at ? ` – ${formatDateTime(run.finished_at)}` : ''}
                    </span>
                    {run.duration_ms != null ? (
                      <span className="text-aux text-text-tertiary">耗时 {formatDuration(run.duration_ms)}</span>
                    ) : null}
                  </div>
                  <p className="text-aux text-text-tertiary">
                    触发方式：{labelOf(TRIGGER_TYPE_LABEL, run.trigger_type)} · 日志 {run.log_count} 条
                    {run.artifacts.length > 0 ? ` · 产物 ${run.artifacts.length} 个` : ''}
                    {run.run_number ? ` · 第 ${run.run_number} 次执行` : ''}
                  </p>
                  <div className="rounded-control bg-bg-muted px-3 py-2">
                    {run.summary ? (
                      <p className="whitespace-pre-wrap text-body text-text-primary" data-selectable>
                        {run.summary}
                      </p>
                    ) : (
                      <p className="text-body text-text-tertiary">
                        本次执行未留下摘要（Agent 侧约定把结论写进 complete_task 的 summary）
                      </p>
                    )}
                  </div>
                  {run.error ? (
                    <p className="text-body text-status-failed">失败原因：{run.error}</p>
                  ) : null}
                  {run.review ? (
                    <p className="text-aux text-text-secondary">
                      历史审核结论：{labelOf(REVIEW_CONCLUSION_LABEL, run.review.conclusion)}（
                      {formatDateTime(run.review.created_at)}）
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-body text-text-tertiary">该任务没有可关联的执行记录（6.6）。</p>
              )}
              {runs.isError ? (
                <p className="mt-2 text-aux text-status-failed">{errorMessage(runs.error)}</p>
              ) : null}
            </Section>
          </CardBody>
        </Card>

        {/* 原型 5.3 上半区：diff 内嵌预览 + 其他产物的动作按钮，都复用抽屉那套已建好的预览器。 */}
        {artifactRun && run && artifactRun.id !== run.id ? (
          <p className="-mt-2 text-aux text-text-tertiary">
            本次执行没有回传产物；以下为该任务最近一次有产物的执行（第
            {artifactRun.run_number ?? '?'} 次 · <Mono>{artifactRun.id}</Mono>）。
          </p>
        ) : null}
        {diffArtifacts.length > 0 ? (
          <Section title="diff 预览">
            <div className="flex flex-col gap-2">
              {diffArtifacts.map((artifact) => (
                <DiffBlock key={artifact.id} artifact={artifact} />
              ))}
            </div>
          </Section>
        ) : null}

        {otherArtifacts.length > 0 ? (
          <Section title="其他产物">
            <ArtifactList
              artifacts={otherArtifacts}
              maxMb={maxMb}
              onPreview={setPreview}
              activeId={preview?.id ?? null}
            />
          </Section>
        ) : null}

        {runs.data && run && artifacts.length === 0 ? (
          <p className="-mt-2 text-aux text-text-tertiary">
            这次执行没有回传产物（6.10.1：报告文件本该作为 json 产物出现在「其他产物」里）。
          </p>
        ) : null}

        {history.length > 0 ? (
          <Section title="历史审核意见">
            <ul className="flex flex-col gap-2">
              {history.slice(0, 3).map((item) => (
                <li key={item.id} className="rounded-control border border-border px-3 py-2">
                  <div className="flex items-center gap-2 text-aux text-text-secondary">
                    <Badge
                      className={
                        item.conclusion === 'APPROVE'
                          ? 'bg-status-done-soft text-status-done'
                          : 'bg-status-failed-soft text-status-failed'
                      }
                    >
                      {labelOf(REVIEW_CONCLUSION_LABEL, item.conclusion)}
                    </Badge>
                    {item.run_id ? (
                      <span className="font-mono text-code" data-selectable>
                        {item.run_id}
                      </span>
                    ) : null}
                    <span className="ml-auto">{formatRelative(item.created_at)}</span>
                  </div>
                  <p className="mt-1 text-body text-text-primary" data-selectable>
                    {item.suggestion}
                  </p>
                  <p className="text-aux text-text-secondary" data-selectable>
                    {item.reason}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <div className="h-px bg-border" />

        {/* ------------------------------------------------------ 表单字段 */}

        <Field label="审核结论" required error={serverErrors.conclusion}>
          <RadioGroup
            value={draft.conclusion}
            options={CONCLUSION_OPTIONS}
            onChange={(value) => patch({ conclusion: value as ReviewConclusion })}
          />
          <p className="text-aux text-text-tertiary">{conclusionCopy}</p>
        </Field>

        {reuseEnabled ? (
          <div className="-mt-2 flex items-center gap-2 text-aux">
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-3.5" aria-hidden />}
              disabled={!previous}
              onClick={() => {
                if (!previous) return;
                patch({
                  suggestion: previous.suggestion,
                  reason: previous.reason,
                  detail: previous.detail,
                });
                suggestionRef.current?.focus();
              }}
            >
              复用上次意见
            </Button>
            <span className="text-text-tertiary">
              {previous
                ? `${formatRelative(previous.created_at)} 的三条意见，填后仍可编辑`
                : '无历史意见'}
            </span>
          </div>
        ) : null}

        {REQUIRED_FIELDS_VIEW.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            required={draft.conclusion === 'REJECT'}
            htmlFor={`review-${field.key}`}
            error={localErrors[field.key] ?? serverErrors[field.key]}
            hint={
              truncated[field.key] ? (
                <span className="text-status-running">
                  超过 {REVIEW_FIELD_MAX} 字，已截断（6.5：单字段 ≤ {REVIEW_FIELD_MAX} 字）
                </span>
              ) : (
                `${draft[field.key].length}/${REVIEW_FIELD_MAX}`
              )
            }
          >
            <Textarea
              id={`review-${field.key}`}
              ref={field.key === 'suggestion' ? suggestionRef : undefined}
              rows={field.rows}
              invalid={Boolean(
                localErrors[field.key] ?? serverErrors[field.key],
              )}
              value={draft[field.key]}
              placeholder={field.placeholder}
              onChange={(event) => setField(field.key, event.target.value)}
            />
          </Field>
        ))}

        {draft.conclusion === 'REJECT' ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={transitions.rise}
            className="flex flex-col gap-4"
          >
            <Field
              label="退回目标"
              required
              error={serverErrors.return_to}
              hint={
                prefill?.returnTo
                  ? '已按拖放目标列预填，可改（原型 3.7：拖到 🔒 列即把目标写进退回目标）'
                  : '默认「待执行」（6.5 第 3 条）'
              }
            >
              <RadioGroup
                value={draft.returnTo}
                options={RETURN_OPTIONS}
                onChange={(value) => patch({ returnTo: value as ReviewDraft['returnTo'] })}
              />
            </Field>
            <Field
              label="优先级调整"
              hint="保持「不变」即不改任务的优先级"
              error={serverErrors.priority_adj}
            >
              <div className="max-w-[200px]">
                <Select
                  aria-label="优先级调整"
                  value={draft.priorityAdj === undefined ? '' : String(draft.priorityAdj)}
                  options={PRIORITY_OPTIONS}
                  onChange={(event) => {
                    const raw = event.target.value;
                    patch({ priorityAdj: raw === '' ? undefined : Number(raw) });
                  }}
                />
              </div>
            </Field>
          </motion.div>
        ) : null}

        {runs.data && !run ? (
          <p className="text-aux text-text-tertiary">
            这次待审核没有可关联的执行记录，提交后审核意见仍会记在任务上（6.6）。
          </p>
        ) : null}

        {/* 预览框与审核模态同宽（1.5 两档），portal 到 body 后盖在本表单之上；
            一次性签名 URL 由 `use-artifact-content` 现签现用，UI Token 不进查询串。 */}
        <ArtifactPreviewDialog target={preview} maxMb={maxMb} onClose={() => setPreview(null)} />
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ 局部件 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-card-title font-medium text-text-secondary">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 原型 5.3 的 diff 区块：标题行（名字 + 体积 + `[下载]`）+ 内嵌 `DiffViewer`。
 * hunk 与行号一律由服务端算（`GET /artifacts/:id/diff`），前端不解析 patch 文本；
 * 「超过 200 行折叠 + 展开全部」是 5.3 的独立一条，得由这里显式传 `collapseAfterLines` 才生效——
 * `DiffViewer` 里面那层 `max-h` 只出滚动条，不是折叠（别再把两者当一回事）。
 */
function DiffBlock({ artifact }: { artifact: RunArtifact }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const download = () => {
    setBusy(true);
    void downloadArtifact(artifact.id, artifact.name)
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="rounded-card border border-border bg-bg-surface p-2">
      <div className="mb-2 flex items-center gap-2">
        <FileCode2 className="size-4 shrink-0 text-text-tertiary" aria-hidden />
        <span
          className="min-w-0 flex-1 truncate text-card-title text-text-primary"
          title={`${labelOf(ARTIFACT_TYPE_LABEL, artifact.type)}：${artifact.name}`}
        >
          {artifact.name}
        </span>
        <span className="shrink-0 text-aux text-text-tertiary">
          {artifact.size_bytes !== null ? formatBytes(artifact.size_bytes) : labelOf(ARTIFACT_TYPE_LABEL, artifact.type)}
        </span>
        <Button size="sm" loading={busy} onClick={download}>
          下载
        </Button>
      </div>
      {/* 200 = 原型 5.3「diff 区块」写死的行数，不在这里另立口径（9.1 预览框无此条，故只有审核侧传）。 */}
      <DiffViewer artifactId={artifact.id} collapseAfterLines={200} />
    </div>
  );
}

function StaleBanner({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-control border border-border border-l-[3px] border-l-status-running bg-status-running-soft px-3 py-2"
    >
      <AlertTriangle className="size-4 shrink-0 text-status-running" aria-hidden />
      <span className="min-w-0 flex-1 text-body text-text-primary">{text}</span>
      <Button size="sm" onClick={onRetry}>
        刷新后重试
      </Button>
    </div>
  );
}

const FIELD_LABEL: Record<RequiredField, string> = {
  suggestion: '审核建议',
  reason: '原因',
  detail: '详情',
};

const REQUIRED_FIELDS_VIEW: readonly {
  key: RequiredField;
  label: string;
  rows: number;
  placeholder: string;
}[] = [
  { key: 'suggestion', label: '审核建议', rows: 2, placeholder: '给 Agent 的一条可执行建议' },
  { key: 'reason', label: '原因', rows: 2, placeholder: '为什么给出这个结论' },
  { key: 'detail', label: '详情', rows: 4, placeholder: '补充上下文：期望改哪里、缺了什么' },
];

/** 执行摘要里 Run 状态徽标的柔和配色，与状态机语义一致（RUNNING=进行中 / SUCCESS=完成 / FAILED=失败 / ABANDONED=放弃）。 */
const RUN_STATUS_SOFT: Record<string, string> = {
  RUNNING: 'bg-status-running-soft text-status-running',
  SUCCESS: 'bg-status-done-soft text-status-done',
  FAILED: 'bg-status-failed-soft text-status-failed',
  ABANDONED: 'bg-status-blocked-soft text-status-blocked',
};

const CONCLUSION_OPTIONS = [
  { value: 'APPROVE', label: '通过' },
  { value: 'REJECT', label: '驳回' },
] as const;

const RETURN_OPTIONS = [
  { value: 'READY', label: '待执行' },
  { value: 'BACKLOG', label: '需求池' },
] as const;

const PRIORITY_OPTIONS = [
  { value: '', label: '不变' },
  { value: '0', label: priorityText(0) },
  { value: '1', label: priorityText(1) },
  { value: '2', label: priorityText(2) },
  { value: '3', label: priorityText(3) },
] as const;
