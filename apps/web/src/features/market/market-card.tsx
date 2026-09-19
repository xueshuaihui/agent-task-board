import { UsersRound } from 'lucide-react';
import { Button, Card, TagBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { RatingStars, SourceBadge, TypeAvatar, TypeLabel } from './bits';
import type { MarketListingSummary } from './types';

/**
 * 市场列表卡（2.md 第十二章 12.2/12.3）：类型图标 + 名称 + 来源徽标 + 描述 +
 * 标签 + 评分星/订阅数 + 订阅按钮。热门区与全部列表共用，hot 态加大内边距。
 */

export interface MarketListingCardProps {
  listing: MarketListingSummary;
  hot?: boolean;
  onOpen: (listing: MarketListingSummary) => void;
  onSubscribe: (listing: MarketListingSummary) => void;
  onUnsubscribe?: (listing: MarketListingSummary) => void;
  subscribed?: boolean;
}

export function MarketListingCard({
  listing,
  hot = false,
  onOpen,
  onSubscribe,
  onUnsubscribe,
  subscribed = false,
}: MarketListingCardProps) {
  return (
    <Card
      hoverable
      className={cn('flex cursor-pointer flex-col gap-2', hot ? 'p-5' : 'p-4', hot && 'border-primary/40')}
      onClick={() => onOpen(listing)}
    >
      <div className="flex items-start gap-2.5">
        <TypeAvatar name={listing.name} type={listing.type} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-card-title text-text-primary">{listing.name}</p>
            {hot ? <span title="热门">🔥</span> : null}
          </div>
          <p className="truncate text-aux text-text-tertiary">
            {listing.slug} · {listing.publisher_name}
          </p>
        </div>
        <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {subscribed && onUnsubscribe ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onUnsubscribe(listing)}
            >
              已订阅
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => onSubscribe(listing)}>
              订阅
            </Button>
          )}
        </div>
      </div>

      <p className="line-clamp-2 min-h-[2lh] text-aux text-text-secondary">
        {listing.description || '（暂无描述）'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <TypeLabel type={listing.type} />
        <SourceBadge source={listing.source} />
        {listing.tags.slice(0, 3).map((tag) => (
          <TagBadge key={tag}>{tag}</TagBadge>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-aux text-text-tertiary">
        <RatingStars value={listing.rating_avg} count={listing.rating_count} />
        <span className="inline-flex items-center gap-1 tabular-nums">
          <UsersRound className="size-3.5" aria-hidden />
          {listing.subscriber_count} 订阅
        </span>
      </div>
    </Card>
  );
}
