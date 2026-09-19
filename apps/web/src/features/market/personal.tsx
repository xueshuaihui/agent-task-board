import { useState, type ReactNode } from 'react';
import { BookmarkCheck, Download, Inbox, PackagePlus, Send, Wrench } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, Field, Select, Textarea, useToast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/time';
import { navigate } from '@/app/router';
import { useAuthStore } from '@/features/auth';
import { SkillDetailDrawer } from '@/features/skills/skill-detail-drawer';
import { useSkills } from '@/features/skills/hooks';
import {
  useMarketDelist,
  useMarketPullUpdate,
  useMarketRespondFeedback,
  useMarketReview,
  useMarketToggleFavorite,
  useMarketUnsubscribe,
  useMarketVerifyFeedback,
  useMarketPublishVersion,
  useMyFavorites,
  useMyFeedbacks,
  useMyPublishes,
  useMarketSubscriptions,
} from './hooks';
import { RatingStars, SourceBadge, TypeLabel } from './bits';
import {
  MARKET_FEEDBACK_STATUS_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_TONE,
  type MarketFeedbackDto,
  type MarketListingSummary,
  type MarketSubscriptionDto,
} from './types';

/**
 * 个人中心（2.md 第十四章）：我的订阅 / 我的收藏 / 我的发布 / 我的反馈。
 * IA 决策：1.md 十四章把个人中心列为市场下的顶级页签，这里做成市场页内的
 * 二级视图（#/market?tab=personal），与 1.md 的「市场（云端）」入口同层，
 * 不新增顶栏导航项；从市场首页右上「个人中心」按钮与订阅/发布 Toast 进入。
 */
export const PERSONAL_TABS = [
  { value: 'subscriptions', label: '我的订阅' },
  { value: 'favorites', label: '我的收藏' },
  { value: 'publishes', label: '我的发布' },
  { value: 'feedbacks', label: '我的反馈' },
] as const;

export function PersonalCenter({ section }: { section: string }) {
  const [localTab, setLocalTab] = useState(section);
  const tab = PERSONAL_TABS.some((item) => item.value === localTab) ? localTab : 'subscriptions';

  return (
    <div className="mx-auto flex w-full max-w-[960px] gap-6 py-6">
      <nav aria-label="个人中心分区" className="flex w-40 shrink-0 flex-col gap-1 self-start">
        {PERSONAL_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-current={tab === item.value ? 'page' : undefined}
            onClick={() => {
              setLocalTab(item.value);
              navigate('market', `?tab=personal&section=${item.value}`);
            }}
            className={cn(
              'rounded-control px-3 py-2 text-left text-body transition-colors',
              tab === item.value
                ? 'bg-primary-light text-primary'
                : 'text-text-secondary hover:bg-bg-muted hover:text-text-primary',
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {tab === 'subscriptions' ? <MySubscriptions /> : null}
        {tab === 'favorites' ? <MyFavorites /> : null}
        {tab === 'publishes' ? <MyPublishes /> : null}
        {tab === 'feedbacks' ? <MyFeedbacks /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 14.1 我的订阅

function MySubscriptions() {
  const query = useMarketSubscriptions();
  const toast = useToast();
  const pull = useMarketPullUpdate((version) => toast.success('已更新到最新版', version ? `快照版本 ${version}` : undefined));
  const unsubscribe = useMarketUnsubscribe(() => toast.success('已取消订阅'));
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);

  if (query.isPending) return <p className="text-aux text-text-tertiary">加载中…</p>;
  const items = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-section-title text-text-primary">我的订阅</p>
      {items.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-8" aria-hidden />}
          title="暂无订阅"
          description="去市场首页逛逛，订阅感兴趣的技能后本地会生成快照"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <SubscriptionRow
              key={item.listing_id}
              item={item}
              onUpdate={() => pull.mutate(item.listing_id)}
              onUnsubscribe={() => {
                if (window.confirm(`取消订阅「${item.listing_name}」？本地快照保留但不再同步。`)) {
                  unsubscribe.mutate(item.listing_id);
                }
              }}
              onOpenLocal={() => setOpenSkillId(item.skill_id)}
            />
          ))}
        </ul>
      )}
      <SkillDetailDrawer
        skillId={openSkillId ?? undefined}
        open={Boolean(openSkillId)}
        onClose={() => setOpenSkillId(null)}
      />
    </div>
  );
}

function SubscriptionRow({
  item,
  onUpdate,
  onUnsubscribe,
  onOpenLocal,
}: {
  item: MarketSubscriptionDto;
  onUpdate: () => void;
  onUnsubscribe: () => void;
  onOpenLocal: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-bg-raised px-4 py-3">
      <button
        type="button"
        onClick={onOpenLocal}
        disabled={!item.skill_id}
        title={item.skill_id ? '打开本地技能详情' : '本地快照缺失'}
        className={cn(
          'min-w-0 flex-1 text-left',
          item.skill_id ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <p className="truncate text-card-title text-text-primary">{item.listing_name}</p>
        <p className="truncate text-aux text-text-tertiary">{item.listing_slug}</p>
      </button>
      <SourceBadge source={item.source} />
      {item.status === 'SYNCED' ? (
        <span className="text-aux text-status-done">已同步 v{item.snapshot_version}</span>
      ) : item.status === 'HAS_UPDATE' ? (
        <span className="inline-flex items-center gap-2 text-aux">
          有更新 v{item.snapshot_version} → v{item.latest_version}
          <Button size="sm" variant="default" icon={<Download className="size-4" />} onClick={onUpdate}>
            更新
          </Button>
        </span>
      ) : (
        <span className="text-aux text-text-tertiary">已下线 · 快照 v{item.snapshot_version} 可继续使用</span>
      )}
      <Button size="sm" variant="ghost" onClick={onUnsubscribe}>
        取消订阅
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------- 14.2 我的收藏

function MyFavorites() {
  const query = useMyFavorites();
  const toast = useToast();
  const toggle = useMarketToggleFavorite((favorited) => {
    if (!favorited) toast.success('已取消收藏');
  });

  if (query.isPending) return <p className="text-aux text-text-tertiary">加载中…</p>;
  const items = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-3">
      <p className="text-section-title text-text-primary">我的收藏</p>
      {items.length === 0 ? (
        <EmptyState
          icon={<BookmarkCheck className="size-8" aria-hidden />}
          title="暂无收藏"
          description="在技能详情页点 ☆ 收藏，方便以后快速找到"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-bg-raised px-4 py-3"
            >
              <button
                type="button"
                onClick={() => navigate('marketDetail', `?id=${encodeURIComponent(item.id)}`)}
                className="min-w-0 flex-1 cursor-pointer text-left"
              >
                <p className="truncate text-card-title text-text-primary">{item.name}</p>
                <p className="truncate text-aux text-text-tertiary">{item.slug}</p>
              </button>
              <TypeLabel type={item.type} />
              <SourceBadge source={item.source} />
              <RatingStars value={item.rating_avg} count={item.rating_count} />
              <Button size="sm" variant="ghost" onClick={() => toggle.mutate(item.id)}>
                取消收藏
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 14.2 我的发布（含审核入口）

function MyPublishes() {
  const account = useAuthStore((state) => state.account);
  const isAdmin = account?.role === 'ADMIN';
  const query = useMyPublishes();

  if (query.isPending) return <p className="text-aux text-text-tertiary">加载中…</p>;
  const items = query.data?.items ?? [];
  const pendingCount = items.filter((item) => item.status === 'PENDING_REVIEW').length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-section-title text-text-primary">我的发布</p>
        {isAdmin && pendingCount > 0 ? (
          <Badge className="bg-status-review-soft text-status-review">{pendingCount} 条待审</Badge>
        ) : null}
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={<PackagePlus className="size-8" aria-hidden />}
          title="还没有发布记录"
          description="在技能库的技能卡片菜单里选「发布到市场」"
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <PublishRow key={item.id} item={item} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PublishRow({ item, isAdmin }: { item: MarketListingSummary; isAdmin: boolean }) {
  const toast = useToast();
  const review = useMarketReview(() => toast.success('审核完成'));
  const delist = useMarketDelist(() => toast.success('已下线'));
  const [versionOpen, setVersionOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  return (
    <li className="flex flex-col gap-2 rounded-card border border-border bg-bg-raised px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('marketDetail', `?id=${encodeURIComponent(item.id)}`)}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <p className="truncate text-card-title text-text-primary">{item.name}</p>
          <p className="truncate text-aux text-text-tertiary">
            {item.slug} · v{item.current_version} · {item.subscriber_count} 订阅
          </p>
        </button>
        <span className={cn('rounded-badge px-2 py-0.5 text-badge', MARKET_STATUS_TONE[item.status])}>
          {item.status_label || MARKET_STATUS_LABEL[item.status]}
        </span>

        <div className="flex items-center gap-1.5">
          {item.status === 'PUBLISHED' || item.status === 'REJECTED' || item.status === 'UNLISTED' ? (
            <Button size="sm" variant="default" icon={<Send className="size-4" />} onClick={() => setVersionOpen(true)}>
              发布新版本
            </Button>
          ) : null}
          {item.status === 'PUBLISHED' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (window.confirm(`下线「${item.name}」？已订阅用户可继续使用快照。`)) delist.mutate(item.id);
              }}
            >
              下线
            </Button>
          ) : null}
          {isAdmin && item.status === 'PENDING_REVIEW' ? (
            <>
              <Button size="sm" variant="primary" onClick={() => review.mutate({ id: item.id, action: 'approve' })}>
                通过
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRejectOpen(true)}>
                驳回
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {item.status === 'REJECTED' && item.review_note ? (
        <p className="text-aux text-status-failed">驳回原因：{item.review_note}</p>
      ) : null}

      <PublishVersionDialog open={versionOpen} listing={item} onClose={() => setVersionOpen(false)} />
      <RejectDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onSubmit={(reason) => {
          review.mutate({ id: item.id, action: 'reject', reason });
          setRejectOpen(false);
        }}
      />
    </li>
  );
}

/** 发布新版本：选一个本地技能（通常是发布源技能的新版本）→ publish-version。 */
function PublishVersionDialog({
  open,
  listing,
  onClose,
}: {
  open: boolean;
  listing: MarketListingSummary;
  onClose: () => void;
}) {
  const toast = useToast();
  const publishVersion = useMarketPublishVersion(() => {
    toast.success('已提交新版本', '可在我的发布里查看审核进度');
    onClose();
  });
  const skills = useSkills();
  const options = (skills.data?.items ?? []).map((skill) => ({
    value: skill.id,
    label: `${skill.name} v${skill.current_version}`,
  }));
  const [skillId, setSkillId] = useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`发布新版本 · ${listing.name}`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!skillId}
            loading={publishVersion.isPending}
            onClick={() => publishVersion.mutate({ id: listing.id, skill_id: skillId })}
          >
            发布
          </Button>
        </div>
      }
    >
      <Field label="选择本地技能版本" hint="以该技能的当前版本内容发布为新版本">
        {options.length === 0 ? (
          <p className="text-aux text-text-tertiary">本地技能库为空，先在技能库创建或更新技能。</p>
        ) : (
          <Select
            value={skillId}
            placeholder="选择技能版本"
            options={options}
            onChange={(event) => setSkillId(event.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

function RejectDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="驳回发布"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!reason.trim()}
            onClick={() => onSubmit(reason)}
          >
            驳回
          </Button>
        </div>
      }
    >
      <Field label="驳回原因" required hint="会展示给发布者">
        <Textarea value={reason} rows={3} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- 14.3 我的反馈

function MyFeedbacks() {
  const account = useAuthStore((state) => state.account);
  const query = useMyFeedbacks();
  if (query.isPending) return <p className="text-aux text-text-tertiary">加载中…</p>;
  const items = query.data?.items ?? [];
  const mine = items.filter((item) => item.account_id === account?.id);
  const received = items.filter((item) => item.account_id !== account?.id);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-section-title text-text-primary">我的反馈</p>
      <FeedbackGroup
        title="我提交的"
        icon={<Inbox className="size-4" aria-hidden />}
        items={mine}
        emptyText="还没有提交过反馈。在技能详情的 ⋯ 菜单里可以提交问题反馈。"
      />
      <FeedbackGroup
        title="作为发布者收到的"
        icon={<Wrench className="size-4" aria-hidden />}
        items={received}
        emptyText="你发布的技能还没有收到反馈。"
        publisher
      />
    </div>
  );
}

function FeedbackGroup({
  title,
  icon,
  items,
  emptyText,
  publisher = false,
}: {
  title: string;
  icon: ReactNode;
  items: MarketFeedbackDto[];
  emptyText: string;
  publisher?: boolean;
}) {
  return (
    <section className="flex flex-col gap-2">
      <p className="inline-flex items-center gap-1.5 text-card-title text-text-secondary">
        {icon}
        {title}
      </p>
      {items.length === 0 ? (
        <p className="rounded-card border border-border bg-bg-raised px-4 py-3 text-aux text-text-tertiary">{emptyText}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <FeedbackRow key={item.id} item={item} publisher={publisher} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FeedbackRow({ item, publisher }: { item: MarketFeedbackDto; publisher: boolean }) {
  const [respondOpen, setRespondOpen] = useState(false);
  return (
    <li className="flex flex-col gap-2 rounded-card border border-border bg-bg-raised px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-card-title text-text-primary">{item.title}</p>
          <p className="truncate text-aux text-text-tertiary">
            {item.listing_name} · {formatDateTime(item.created_at)}
          </p>
        </div>
        <span
          className={cn(
            'rounded-badge px-2 py-0.5 text-badge',
            item.status === 'RESOLVED' && 'bg-status-done-soft text-status-done',
            item.status === 'PENDING' && 'bg-status-review-soft text-status-review',
            item.status === 'FIXED_PENDING_VERIFY' && 'bg-status-ready-soft text-status-ready',
            item.status === 'WONTFIX' && 'bg-bg-muted text-text-secondary',
          )}
        >
          {MARKET_FEEDBACK_STATUS_LABEL[item.status]}
        </span>
        {publisher && item.status === 'PENDING' ? (
          <Button size="sm" variant="primary" onClick={() => setRespondOpen(true)}>
            响应
          </Button>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap text-aux text-text-secondary">{item.content}</p>
      {item.author_response ? (
        <p className="rounded-card bg-bg-muted px-3 py-2 text-aux text-text-secondary">
          发布者回复：{item.author_response}
        </p>
      ) : null}
      {!publisher && item.status === 'FIXED_PENDING_VERIFY' ? (
        <VerifyButtons feedbackId={item.id} />
      ) : null}
      {publisher && item.status === 'PENDING' ? (
        <RespondDialog open={respondOpen} feedbackId={item.id} onClose={() => setRespondOpen(false)} />
      ) : null}
    </li>
  );
}

/** 验证已修复 / 问题仍存在（9.5 验证闭环）。 */
function VerifyButtons({ feedbackId }: { feedbackId: string }) {
  const toast = useToast();
  const verify = useMarketVerifyFeedback(() => toast.success('已提交验证结果'));
  return (
    <div className="flex items-center gap-2">
      <span className="text-aux text-text-tertiary">发布者已标记修复，请验证：</span>
      <Button
        size="sm"
        variant="primary"
        loading={verify.isPending}
        onClick={() => verify.mutate({ feedbackId, confirmed: true })}
      >
        验证已修复
      </Button>
      <Button size="sm" variant="ghost" onClick={() => verify.mutate({ feedbackId, confirmed: false })}>
        问题仍存在
      </Button>
    </div>
  );
}

function RespondDialog({
  open,
  feedbackId,
  onClose,
}: {
  open: boolean;
  feedbackId: string;
  onClose: () => void;
}) {
  const [response, setResponse] = useState('');
  const [resolution, setResolution] = useState<'fixed' | 'wontfix'>('fixed');
  const respond = useMarketRespondFeedback(() => {
    onClose();
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="响应反馈"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!response.trim()}
            loading={respond.isPending}
            onClick={() => respond.mutate({ feedbackId, response, resolution })}
          >
            提交响应
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="回复内容" required>
          <Textarea value={response} rows={4} maxLength={2000} onChange={(event) => setResponse(event.target.value)} />
        </Field>
        <Field label="处理结果">
          <Select
            value={resolution}
            onChange={(event) => setResolution(event.target.value as 'fixed' | 'wontfix')}
            options={[
              { value: 'fixed', label: '已修复' },
              { value: 'wontfix', label: '不修' },
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}
