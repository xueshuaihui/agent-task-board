import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, History, Loader2, Search } from 'lucide-react';
import type { BreakdownSession } from '@/api/types';
import { navigate, useRoute } from '@/app/router';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorCopy,
  IconButton,
  Input,
  Switch,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/time';
import { BreakdownStatusBadge } from './session-switcher';
import { BreakdownWorkspace } from './breakdown-overlay';
import { useBreakdownHistory, useBreakdownSessions } from './queries';
import { filterLoadedSessions, HISTORY_SEARCH_PLACEHOLDER, historySearchHint } from './history';

/**
 * #4.3 方案 B：拆解二级页面 `#/requirements/breakdown`（在内容区，不是 portal/fixed）。
 *
 * 与覆盖层共用 `BreakdownWorkspace`（business JSX 只此一份），页面外壳只多做三件事：
 * 1. **URL 状态**：当前会话由 `?session=<id>` 驱动，切换会话写回 URL 并保留
 *    `?requirement=<id>`；没有 session 时进行中段回落到第一条会话；
 * 2. **进行中 / 历史**：进行中走 `scope=active`；历史走 `scope=history`，默认
 *    `include_archived=false`，可显式含已归档父需求的会话；
 * 3. **历史只读**：历史列表支持 cursor「加载更多」与**已加载记录内**搜索；详情区
 *    渲染同一份 Workspace——终态会话本身没有写动作（无添加/编辑/重生成/确认）。
 *
 * 入口口径：需求页 header「拆解记录」进本页（不带 requirement）；需求菜单
 * 「拆解历史」带 `?requirement=<id>` 过滤到该需求。左主导航仍不出现「拆解」。
 */
export function BreakdownPage() {
  const route = useRoute();
  const sessionParam = route.search.get('session');
  const requirementId = route.search.get('requirement');

  /**
   * 默认段：需求菜单「拆解历史」只带 `?requirement=` 进来，落历史段才符合入口语义；
   * 需求页 header「拆解记录」不带 requirement，落进行中段。用户随后可自由切换。
   */
  const [tab, setTab] = useState<'active' | 'history'>(requirementId ? 'history' : 'active');
  /** 历史段默认不含父需求已归档的会话（后端默认值同口径）。 */
  const [includeArchived, setIncludeArchived] = useState(false);
  const [historyKeyword, setHistoryKeyword] = useState('');

  const active = useBreakdownSessions({
    scope: 'active',
    ...(requirementId ? { requirement_id: requirementId } : {}),
  });
  const history = useBreakdownHistory(
    {
      scope: 'history',
      include_archived: includeArchived,
      limit: 20,
      ...(requirementId ? { requirement_id: requirementId } : {}),
    },
    { enabled: tab === 'history' },
  );

  const activeSessions = useMemo(() => active.data ?? [], [active.data]);
  const historySessions = useMemo(
    () => history.data?.pages.flatMap((page) => page) ?? [],
    [history.data],
  );
  const filteredHistory = useMemo(
    () => filterLoadedSessions(historySessions, historyKeyword),
    [historySessions, historyKeyword],
  );

  /**
   * URL 是当前会话的唯一真相：session 命中当前段才采用；否则进行中段回落到
   * 第一条（「没有 session 时回落到第一个进行中会话」），历史段则显示选择提示。
   */
  const activeId =
    sessionParam && activeSessions.some((session) => session.id === sessionParam)
      ? sessionParam
      : (activeSessions[0]?.id ?? null);
  const historyId =
    sessionParam && historySessions.some((session) => session.id === sessionParam)
      ? sessionParam
      : null;

  /**
   * 深链 `?session=<history-id>` 默认也在进行中段（#4.3 的页签默认值），首次拿到
   * 进行中列表后按 session 归属纠正一次段位；之后的手动切换不再被 URL 拉回。
   */
  const autoTabApplied = useRef(false);
  useEffect(() => {
    if (autoTabApplied.current || !sessionParam || !active.isSuccess) return;
    autoTabApplied.current = true;
    setTab(activeSessions.some((session) => session.id === sessionParam) ? 'active' : 'history');
  }, [sessionParam, active.isSuccess, activeSessions]);

  /** 切会话只改 query：`?session=…&requirement=…`（requirement 原样保留）。 */
  const selectSession = (id: string) => {
    const params = new URLSearchParams();
    params.set('session', id);
    if (requirementId) params.set('requirement', requirementId);
    navigate('breakdown', `?${params.toString()}`);
  };

  /** 页面返回需求页；把需求筛选带回去，便于从需求进入后原路返回。 */
  const backToRequirements = () => {
    navigate(
      'requirements',
      requirementId ? `?requirement=${encodeURIComponent(requirementId)}` : '',
    );
  };

  const clearRequirement = () => {
    const params = new URLSearchParams();
    if (sessionParam) params.set('session', sessionParam);
    const search = params.toString();
    navigate('breakdown', search ? `?${search}` : '');
  };

  const requirementLabel =
    historySessions.find((session) => session.parent_task_id === requirementId)?.parent_title ??
    activeSessions.find((session) => session.parent_task_id === requirementId)?.parent_title ??
    requirementId;

  return (
    <div className="flex min-h-0 w-full flex-col gap-4" data-testid="breakdown-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <IconButton
            variant="ghost"
            label="返回需求"
            onClick={backToRequirements}
            data-testid="breakdown-page-back"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </IconButton>
          <div className="min-w-0">
            <h1 className="text-page-title text-text-primary">拆解</h1>
            <p className="text-aux text-text-secondary">
              {requirementId ? `需求筛选：${requirementLabel}` : '进行中的拆解可继续处理；历史会话只读'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {requirementId ? (
            <Button
              size="sm"
              variant="default"
              onClick={clearRequirement}
              data-testid="breakdown-clear-requirement"
            >
              清除需求筛选
            </Button>
          ) : null}
          <Tabs
            ariaLabel="拆解视图"
            variant="segmented"
            value={tab}
            onChange={(value) => setTab(value as 'active' | 'history')}
            items={[
              { value: 'active', label: '进行中', count: activeSessions.length },
              { value: 'history', label: '历史' },
            ]}
          />
        </div>
      </header>

      {tab === 'active' ? (
        <div className="grid min-h-0 grid-cols-1 items-start gap-4 min-[1000px]:grid-cols-[320px_minmax(0,1fr)]">
          <SessionListPanel
            title="进行中会话"
            description="接收中 / 待确认 / 创建中的会话；点一条在右侧继续处理。"
            sessions={activeSessions}
            activeId={activeId}
            status={{
              isPending: active.isPending,
              isError: active.isError,
              error: active.error,
            }}
            onSelect={selectSession}
            emptyTitle="没有进行中的拆解"
            emptyDescription={
              requirementId
                ? '该需求当前没有进行中的拆解会话；可切到「历史」查看终结会话。'
                : 'Agent 调用 board.begin_breakdown 后，会话会出现在这里。'
            }
            itemTestId="breakdown-active-item"
          />
          <BreakdownWorkspace
            variant="page"
            sessions={[]}
            activeId={activeId}
            onSelectSession={selectSession}
            onBack={backToRequirements}
            listStatus={active}
            emptyDescription={
              requirementId
                ? '该需求当前没有进行中的拆解会话。'
                : 'Agent 调用 board.begin_breakdown 后会话会出现在这里。'
            }
          />
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-1 items-start gap-4 min-[1000px]:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="flex min-w-0 flex-col gap-3 p-3" data-testid="breakdown-history-panel">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-section-title text-text-primary">历史会话</h2>
              <span className="text-aux text-text-tertiary">{historySessions.length} 条已加载</span>
            </div>
            <p className="text-aux text-text-tertiary">
              历史会话只读：可查看草案与关联需求，不提供添加、编辑或重新生成。
            </p>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" />
              <Input
                aria-label={HISTORY_SEARCH_PLACEHOLDER}
                className="pl-7"
                value={historyKeyword}
                placeholder={HISTORY_SEARCH_PLACEHOLDER}
                onChange={(event) => setHistoryKeyword(event.target.value)}
              />
            </div>
            <p className="text-aux text-text-tertiary" data-testid="breakdown-history-search-hint">
              {historySearchHint(historySessions.length)}
            </p>
            <div className="flex items-center justify-between gap-2 text-aux text-text-secondary">
              <span>包含已归档需求</span>
              <Switch
                checked={includeArchived}
                onChange={setIncludeArchived}
                label="包含已归档需求"
              />
            </div>

            {history.isError ? (
              <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-status-failed-soft p-3 text-aux text-status-failed">
                <ErrorCopy error={history.error} />
                <Button size="sm" onClick={() => void history.refetch()}>
                  重试
                </Button>
              </div>
            ) : history.isPending ? (
              <p className="flex items-center gap-2 py-3 text-aux text-text-tertiary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                正在加载历史会话…
              </p>
            ) : filteredHistory.length === 0 ? (
              <EmptyState
                className="py-6"
                title={historyKeyword ? '没有匹配的历史会话' : '还没有历史会话'}
                description={
                  historyKeyword
                    ? '搜索只过滤当前已加载的分页；可先「加载更多」再搜。'
                    : includeArchived
                      ? '完成 / 取消 / 中断的拆解会话会出现在这里。'
                      : '完成 / 取消 / 中断的拆解会话会出现在这里；父需求已归档的默认隐藏。'
                }
              />
            ) : (
              <ul className="flex flex-col gap-1.5" data-testid="breakdown-history-list">
                {filteredHistory.map((session) => (
                  <li key={session.id}>
                    <SessionListItem
                      session={session}
                      active={session.id === historyId}
                      onClick={() => selectSession(session.id)}
                      showArchived
                      testId="breakdown-history-item"
                    />
                  </li>
                ))}
              </ul>
            )}

            {history.hasNextPage ? (
              <Button
                size="sm"
                variant="default"
                className="self-center"
                loading={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
                data-testid="breakdown-history-load-more"
              >
                加载更多
              </Button>
            ) : null}
            {!history.hasNextPage && historySessions.length > 0 ? (
              <p className="text-center text-aux text-text-tertiary">已加载全部历史会话</p>
            ) : null}
          </Card>

          <BreakdownWorkspace
            variant="page"
            sessions={[]}
            activeId={historyId}
            onSelectSession={selectSession}
            onBack={backToRequirements}
            listStatus={history}
            emptyDescription={
              filteredHistory.length > 0
                ? '从左侧选择一条历史会话查看只读详情。'
                : '当前筛选下没有可查看的历史会话。'
            }
          />
        </div>
      )}
    </div>
  );
}

/** 左侧会话列表（进行中/历史共用一张卡片长相，差异只在是否标父需求归档）。 */
function SessionListPanel({
  title,
  description,
  sessions,
  activeId,
  status,
  onSelect,
  emptyTitle,
  emptyDescription,
  itemTestId,
}: {
  title: string;
  description: string;
  sessions: readonly BreakdownSession[];
  activeId: string | null;
  status: { isPending: boolean; isError: boolean; error?: unknown };
  onSelect: (id: string) => void;
  emptyTitle: string;
  emptyDescription: string;
  itemTestId: string;
}) {
  return (
    <Card className="flex min-w-0 flex-col gap-2 p-3" data-testid="breakdown-active-panel">
      <h2 className="text-section-title text-text-primary">{title}</h2>
      <p className="text-aux text-text-tertiary">{description}</p>
      {status.isError ? (
        <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-status-failed-soft p-3 text-aux text-status-failed">
          <ErrorCopy error={status.error} />
        </div>
      ) : status.isPending ? (
        <p className="flex items-center gap-2 py-3 text-aux text-text-tertiary">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          正在加载进行中会话…
        </p>
      ) : sessions.length === 0 ? (
        <EmptyState className="py-6" title={emptyTitle} description={emptyDescription} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sessions.map((session) => (
            <li key={session.id}>
              <SessionListItem
                session={session}
                active={session.id === activeId}
                onClick={() => onSelect(session.id)}
                testId={itemTestId}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 单条会话摘要：状态、需求标题、时间、Agent、草案数（历史/进行中同口径）。 */
function SessionListItem({
  session,
  active,
  onClick,
  showArchived = false,
  testId,
}: {
  session: BreakdownSession;
  active: boolean;
  onClick: () => void;
  showArchived?: boolean;
  testId: string;
}) {
  const time = session.finished_at ?? session.cancelled_at ?? session.created_at;
  const timeLabel = session.finished_at || session.cancelled_at ? '终结于' : '创建于';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      data-testid={testId}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-card border p-2.5 text-left transition-colors',
        active
          ? 'border-primary bg-primary-light'
          : 'border-border bg-bg-surface hover:bg-bg-muted',
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-card-title text-text-primary" title={session.parent_title}>
          {session.parent_title}
        </span>
        <BreakdownStatusBadge status={session.status} />
      </div>
      <p className="line-clamp-2 text-aux text-text-secondary" title={session.requirement_text}>
        {session.requirement_text}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-aux text-text-tertiary">
        <span>
          {timeLabel} {formatDateTime(time)}
        </span>
        <span>· Agent {session.agent_name ?? '—'}</span>
        <span>
          · 草案 {session.actual_tasks ?? '—'}
          {session.estimated_tasks ? `（预估 ${session.estimated_tasks}）` : ''}
        </span>
        {showArchived && session.parent_archived_at ? (
          <Badge tone="neutral" icon={<History className="size-3" aria-hidden />}>
            父需求已归档
          </Badge>
        ) : null}
      </div>
    </button>
  );
}
