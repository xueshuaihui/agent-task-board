import { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BellOff,
  Copy,
  Flag,
  MessageSquareWarning,
  RefreshCw,
  Star,
  UsersRound,
} from 'lucide-react';
import { Button, Dialog, EmptyState, Field, Menu, Skeleton, Tabs, TagBadge, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/time';
import { navigate, useRoute } from '@/app/router';
import { useAuthStore } from '@/features/auth';
import { BLOCK_KIND_META } from '@/features/skills/meta';
import {
  useMarketComment,
  useMarketDeleteComment,
  useMarketDetail,
  useMarketPullUpdate,
  useMarketRate,
  useMarketReport,
  useMarketSubscribe,
  useMarketToggleFavorite,
  useMarketUnsubscribe,
  useMarketCreateFeedback,
} from './hooks';
import { RatingStars, SourceBadge, TypeAvatar, TypeLabel } from './bits';
import type { MarketCommentDto } from './types';

/**
 * 市场技能详情页（2.md 第十三章）：头部元信息 + 说明/内容/评论/使用记录四个 Tab，
 * 右上 订阅[订阅/更新/已订阅]、收藏☆、⋯（反馈/举报）。
 * DELISTED 显示「已下线，快照可继续使用」横幅；非发布者打开未上架 listing 时
 * 后端 404，这里给兜底空态（13.5）。
 */
export function MarketDetailPage({ listingId }: { listingId: string }) {
  return <DetailBody listingId={listingId} key={listingId} />;
}

function DetailBody({ listingId }: { listingId: string }) {
  const route = useRoute();
  const query = useMarketDetail(listingId);
  const detail = query.data;
  const [tab, setTab] = useState('about');

  const back = () => {
    const tab = route.search.get('from');
    navigate('market', tab ? `?tab=${encodeURIComponent(tab)}` : '');
  };

  if (query.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 py-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.isError || !detail) {
    return (
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 py-6">
        <BackLink onBack={back} />
        <EmptyState
          icon={<AlertTriangle className="size-8 text-status-failed" aria-hidden />}
          title="无法查看该技能"
          description={`可能已下架、不存在或你没有权限查看（${errorMessage(query.error)}）`}
          action={
            <Button variant="ghost" onClick={back}>
              返回市场
            </Button>
          }
        />
      </div>
    );
  }

  const delisted = detail.status === 'DELISTED';

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 py-6">
      <BackLink onBack={back} />

      {delisted ? (
        <div className="flex items-center gap-2 rounded-card border border-border bg-bg-muted px-4 py-3 text-aux text-text-secondary">
          <BellOff className="size-4 shrink-0" aria-hidden />
          该技能已下线，快照可继续使用；已订阅用户不受影响，但不再收到更新。
        </div>
      ) : null}

      <header className="flex flex-col gap-3 rounded-card border border-border bg-bg-raised p-5">
        <div className="flex items-start gap-3">
          <TypeAvatar name={detail.name} type={detail.type} />
          <div className="min-w-0 flex-1">
            <h1 className="text-page-title text-text-primary">{detail.name}</h1>
            <p className="mt-0.5 truncate text-aux text-text-tertiary">
              {detail.slug} · {detail.publisher_name} · v{detail.current_version}
              {detail.license ? ` · ${detail.license}` : ''}
            </p>
          </div>
          <DetailActions listingId={detail.id} />
        </div>
        <p className="text-body text-text-secondary">{detail.description || '（暂无描述）'}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <TypeLabel type={detail.type} />
          <SourceBadge source={detail.source} />
          {detail.category ? <TagBadge>{detail.category}</TagBadge> : null}
          {detail.tags.map((tag) => (
            <TagBadge key={tag}>{tag}</TagBadge>
          ))}
          {detail.compatible_clients.map((client) => (
            <TagBadge key={client}>{client}</TagBadge>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3 text-aux text-text-tertiary">
          <RatingStars value={detail.rating.avg} count={detail.rating.count} />
          <span className="inline-flex items-center gap-1 tabular-nums">
            <UsersRound className="size-3.5" aria-hidden />
            {detail.subscriber_count} 订阅
          </span>
          <span className="tabular-nums">浏览 {detail.view_count}</span>
          {detail.published_at ? <span>发布于 {formatDateTime(detail.published_at)}</span> : null}
        </div>
      </header>

      <Tabs
        variant="underline"
        value={tab}
        onChange={setTab}
        ariaLabel="市场技能详情分区"
        items={[
          { value: 'about', label: '说明' },
          { value: 'content', label: '内容' },
          { value: 'comments', label: `评论`, count: detail.comments.total },
          { value: 'usage', label: '使用记录' },
        ]}
        className="-mx-5"
      />

      {tab === 'about' ? <AboutTab listingId={detail.id} description={detail.description} mcp={detail.mcp_dependencies} /> : null}
      {tab === 'content' ? <ContentTab listingId={detail.id} /> : null}
      {tab === 'comments' ? <CommentsTab listingId={detail.id} comments={detail.comments.items} /> : null}
      {tab === 'usage' ? <UsageTab listingId={detail.id} /> : null}
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="inline-flex w-fit items-center gap-1 self-start text-aux text-text-secondary transition-colors hover:text-primary"
    >
      <ArrowLeft className="size-4" aria-hidden />
      返回市场
    </button>
  );
}

function DetailActions({ listingId }: { listingId: string }) {
  const detail = useMarketDetail(listingId).data;
  if (!detail) return null;
  const my = detail.my;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {my.subscribed ? (
        <SubscribeButtonGroup listingId={listingId} delisted={detail.status === 'DELISTED'} />
      ) : (
        <SubscribeButton listingId={listingId} />
      )}
      <FavoriteButton listingId={listingId} favorited={my.favorited} />
      <MoreMenu listingId={listingId} />
    </div>
  );
}

function SubscribeButton({ listingId }: { listingId: string }) {
  const toast = useToast();
  const subscribe = useMarketSubscribe(() => toast.success('订阅成功', '已在本地生成技能快照，可在个人中心-我的订阅查看'));
  return (
    <Button
      size="sm"
      variant="primary"
      loading={subscribe.isPending}
      onClick={() => subscribe.mutate(listingId)}
    >
      订阅
    </Button>
  );
}

/** 已订阅态：更新（有新版本时拉取）+ 已订阅（取消订阅）。 */
function SubscribeButtonGroup({ listingId, delisted }: { listingId: string; delisted: boolean }) {
  const toast = useToast();
  const pull = useMarketPullUpdate((version) => toast.success('已更新到最新版', version ? `快照版本 ${version}` : undefined));
  const unsubscribe = useMarketUnsubscribe(() => toast.success('已取消订阅'));
  return (
    <>
      {!delisted ? (
        <Button
          size="sm"
          variant="default"
          icon={<RefreshCw className="size-4" />}
          loading={pull.isPending}
          onClick={() => pull.mutate(listingId)}
        >
          更新
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        loading={unsubscribe.isPending}
        onClick={() => {
          if (window.confirm('取消订阅后本地快照保留但不再同步更新，确定取消？')) {
            unsubscribe.mutate(listingId);
          }
        }}
      >
        已订阅
      </Button>
    </>
  );
}

function FavoriteButton({ listingId, favorited }: { listingId: string; favorited: boolean }) {
  const toast = useToast();
  const toggle = useMarketToggleFavorite((next) =>
    toast.success(next ? '已加入收藏' : '已取消收藏'),
  );
  return (
    <button
      type="button"
      aria-label={favorited ? '取消收藏' : '收藏'}
      title={favorited ? '取消收藏' : '收藏'}
      onClick={() => toggle.mutate(listingId)}
      className={cn(
        'flex size-8 items-center justify-center rounded-control transition-colors hover:bg-bg-muted',
        favorited ? 'text-status-review' : 'text-text-tertiary hover:text-text-primary',
      )}
    >
      <Star className={cn('size-4', favorited && 'fill-status-review')} />
    </button>
  );
}

function MoreMenu({ listingId }: { listingId: string }) {
  const [reportOpen, setReportOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <>
      <Menu
        align="end"
        width={180}
        trigger={({ toggle }) => (
          <button
            type="button"
            aria-label="更多操作"
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-control text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
          >
            ⋯
          </button>
        )}
        groups={[
          {
            items: [
              {
                id: 'feedback',
                label: '提交反馈',
                icon: <MessageSquareWarning className="size-4" />,
                onSelect: () => setFeedbackOpen(true),
              },
              {
                id: 'report',
                label: '举报',
                danger: true,
                icon: <Flag className="size-4" />,
                onSelect: () => setReportOpen(true),
              },
            ],
          },
        ]}
      />
      <ReportDialog open={reportOpen} listingId={listingId} onClose={() => setReportOpen(false)} />
      <FeedbackDialog open={feedbackOpen} listingId={listingId} onClose={() => setFeedbackOpen(false)} />
    </>
  );
}

function ReportDialog({ open, listingId, onClose }: { open: boolean; listingId: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const report = useMarketReport(() => {
    onClose();
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="举报该技能"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={report.isPending}
            disabled={!reason.trim()}
            onClick={() => report.mutate({ id: listingId, reason })}
          >
            提交举报
          </Button>
        </div>
      }
    >
      <Field label="举报原因" required hint="提交后由管理员处理">
        <Textarea value={reason} rows={4} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Dialog>
  );
}

function FeedbackDialog({ open, listingId, onClose }: { open: boolean; listingId: string; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const create = useMarketCreateFeedback(() => {
    onClose();
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="提交问题反馈"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!title.trim() || !content.trim()}
            onClick={() => create.mutate({ id: listingId, title, content })}
          >
            提交
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="标题" required>
          <Textarea
            value={title}
            rows={2}
            maxLength={100}
            placeholder="一句话描述问题"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="详细描述" required>
          <Textarea
            value={content}
            rows={5}
            maxLength={2000}
            placeholder="复现步骤、期望与实际表现"
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** 说明 Tab：描述全文 + 输入参数 + MCP 依赖 + 复制配置片段（13.2）。 */
function AboutTab({
  listingId,
  description,
  mcp,
}: {
  listingId: string;
  description: string;
  mcp: { server: string; tools: string[]; required: boolean; reason?: string }[];
}) {
  const toast = useToast();
  const detail = useMarketDetail(listingId).data;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      toast.success('已复制配置片段');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="whitespace-pre-wrap text-body text-text-secondary">{description || '（暂无说明）'}</p>

      {detail ? <InputParamsTab listingId={listingId} /> : null}

      <div className="flex flex-col gap-2">
        <p className="text-card-title text-text-secondary">MCP 依赖</p>
        {mcp.length === 0 ? (
          <p className="text-aux text-text-tertiary">未声明 MCP 依赖。</p>
        ) : (
          mcp.map((dep, index) => (
            <div key={index} className="rounded-card border border-border bg-bg-raised p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-card-title text-text-primary">
                  {dep.server}
                  <span className="ml-2 text-aux text-text-tertiary">{dep.required ? '必需' : '可选'}</span>
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Copy className="size-4" />}
                  onClick={() =>
                    copy(
                      JSON.stringify(
                        {
                          mcpServers: {
                            [dep.server]: {
                              tools: dep.tools,
                              required: dep.required,
                              ...(dep.reason ? { reason: dep.reason } : {}),
                            },
                          },
                        },
                        null,
                        2,
                      ),
                    )
                  }
                >
                  复制配置片段
                </Button>
              </div>
              <p className="mt-1 text-aux text-text-secondary">工具：{dep.tools.join('、') || '（未声明）'}</p>
              {dep.reason ? <p className="text-aux text-text-tertiary">{dep.reason}</p> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 输入参数：从 content 的 input 块聚合（13.2 的「输入参数」区）。 */
function InputParamsTab({ listingId }: { listingId: string }) {
  const detail = useMarketDetail(listingId).data;
  const inputs = (detail?.content?.blocks ?? []).filter((block) => block.kind === 'input');
  if (inputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-card-title text-text-secondary">输入参数</p>
      <div className="overflow-hidden rounded-card border border-border">
        {inputs.map((block) => (
          <div
            key={block.id}
            className="flex items-center justify-between gap-3 border-b border-border bg-bg-raised px-3 py-2 text-body last:border-b-0"
          >
            <span className="font-mono text-text-primary">{block.name || block.title}</span>
            <span className="text-aux text-text-tertiary">
              {block.valueType ?? 'string'}
              {block.required ? ' · 必填' : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 内容 Tab：块预览，与技能详情抽屉 OverviewTab 同一展示语言（13.3）。 */
function ContentTab({ listingId }: { listingId: string }) {
  const detail = useMarketDetail(listingId).data;
  const blocks = detail?.content?.blocks ?? [];
  if (blocks.length === 0) {
    return <EmptyState title="暂无内容块" description="该技能没有可预览的内容块" />;
  }
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => {
        const meta = BLOCK_KIND_META[block.kind];
        return (
          <div key={block.id} className="rounded-card border border-border bg-bg-raised p-3">
            <div className="flex items-center gap-2">
              <span className={cn('rounded-tag px-1.5 py-0.5 text-badge', meta.kindClass)}>
                {meta.label}
              </span>
              <p className="text-card-title text-text-primary">
                {index + 1}. {block.title || meta.label}
                {detail?.content?.entryBlockId === block.id ? (
                  <span className="ml-2 text-aux text-primary">入口</span>
                ) : null}
              </p>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-aux text-text-secondary">
              {meta.summary(block) || '（无内容）'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function CommentsTab({ listingId, comments }: { listingId: string; comments: MarketCommentDto[] }) {
  const account = useAuthStore((state) => state.account);
  const [draft, setDraft] = useState('');
  const comment = useMarketComment();
  const remove = useMarketDeleteComment();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Textarea
          value={draft}
          rows={3}
          maxLength={500}
          placeholder="发表评论…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          className="self-end"
          loading={comment.isPending}
          disabled={!draft.trim()}
          onClick={() =>
            comment.mutate({ id: listingId, content: draft }, { onSuccess: () => setDraft('') })
          }
        >
          发表评论
        </Button>
      </div>

      {comments.length === 0 ? (
        <EmptyState title="还没有评论" description="第一个分享使用体验的人就是你" />
      ) : (
        <ul className="flex flex-col gap-2">
          {comments.map((item) => (
            <li key={item.id} className="rounded-card border border-border bg-bg-raised px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-aux text-text-secondary">
                  {item.author_name} · {formatRelative(item.created_at)}
                </p>
                {account && item.account_id === account.id ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={remove.isPending}
                    onClick={() => {
                      if (window.confirm('删除这条评论？')) remove.mutate(item.id);
                    }}
                  >
                    删除
                  </Button>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-body text-text-primary">{item.content}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 使用记录：订阅数 + 评分分布简化版（平均分/人数 + 我的评分，点星评分）。 */
function UsageTab({ listingId }: { listingId: string }) {
  const detail = useMarketDetail(listingId).data;
  const toast = useToast();
  const rate = useMarketRate(() => toast.success('评分成功'));
  if (!detail) return null;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-card border border-border bg-bg-raised p-4 text-center">
          <p className="text-page-title tabular-nums text-text-primary">{detail.subscriber_count}</p>
          <p className="text-aux text-text-tertiary">订阅数</p>
        </div>
        <div className="rounded-card border border-border bg-bg-raised p-4 text-center">
          <p className="text-page-title tabular-nums text-text-primary">
            {detail.rating.avg > 0 ? detail.rating.avg.toFixed(1) : '—'}
          </p>
          <p className="text-aux text-text-tertiary">平均评分</p>
        </div>
        <div className="rounded-card border border-border bg-bg-raised p-4 text-center">
          <p className="text-page-title tabular-nums text-text-primary">{detail.rating_count}</p>
          <p className="text-aux text-text-tertiary">评分人数</p>
        </div>
      </div>
      <div className="rounded-card border border-border bg-bg-raised p-4">
        <p className="text-card-title text-text-secondary">我的评分</p>
        <div className="mt-2 flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              aria-label={`${star} 星`}
              disabled={rate.isPending}
              onClick={() => rate.mutate({ id: listingId, score: star })}
              className="rounded-control p-1 transition-colors hover:bg-bg-muted"
            >
              <Star
                className={cn(
                  'size-5',
                  star <= (detail.my.rating ?? 0) ? 'fill-status-review text-status-review' : 'text-text-tertiary',
                )}
              />
            </button>
          ))}
          {detail.my.rating ? (
            <span className="ml-2 text-aux text-text-tertiary">已评 {detail.my.rating} 分，点击可修改</span>
          ) : (
            <span className="ml-2 text-aux text-text-tertiary">点击星星评分</span>
          )}
        </div>
      </div>
    </div>
  );
}
