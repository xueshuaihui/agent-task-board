import { useMemo, useState } from 'react';
import { Flame, Search, Sparkles, UserRound } from 'lucide-react';
import { Button, CardSkeleton, EmptyState, Input, Select, useToast } from '@/components/ui';
import { navigate, useRoute } from '@/app/router';
import { MarketListingCard } from './market-card';
import { PersonalCenter } from './personal';
import {
  useMarketListings,
  useMarketSubscribe,
  useMarketSubscriptions,
  useMarketUnsubscribe,
} from './hooks';
import { COMPATIBLE_CLIENTS, MARKET_CATEGORIES, type MarketListingSummary, type MarketSort } from './types';
import { SKILL_TYPE_OPTIONS } from '@/features/skills/meta';

/**
 * 市场首页（2.md 第十二章）：搜索 + 分类/类型/评分/兼容客户端筛选 + 排序；
 * 🔥热门（订阅数前 3）大卡、🆕最新行、全部列表（加载更多）。右上「个人中心」
 * 进入十四章的我的订阅/收藏/发布/反馈（#/market?tab=personal）。
 */
const PAGE_STEP = 12;

export function MarketPage() {
  const route = useRoute();
  const section = route.search.get('section') ?? '';

  if (route.search.get('tab') === 'personal') {
    return <PersonalCenter section={section} />;
  }
  return <MarketBrowse />;
}

function MarketBrowse() {
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [type, setType] = useState('');
  const [minRating, setMinRating] = useState('');
  const [client, setClient] = useState('');
  const [sort, setSort] = useState<MarketSort>('hot');
  const [visible, setVisible] = useState(PAGE_STEP);

  const query = useMemo(
    () => ({
      keyword: keyword || undefined,
      category: category || undefined,
      type: type || undefined,
      min_rating: minRating ? Number(minRating) : undefined,
      compatible_client: client || undefined,
      sort,
    }),
    [keyword, category, type, minRating, client, sort],
  );

  const listQuery = useMarketListings(query);
  const subscriptions = useMarketSubscriptions();
  const toast = useToast();
  const subscribeMut = useMarketSubscribe(() => toast.success('订阅成功', '已在本地生成技能快照，可在个人中心-我的订阅查看'));
  const unsubscribeMut = useMarketUnsubscribe(() => toast.success('已取消订阅'));

  const openListing = (listing: MarketListingSummary) =>
    navigate('marketDetail', `?id=${encodeURIComponent(listing.id)}`);
  const subscribe = (listing: MarketListingSummary) => subscribeMut.mutate(listing.id);
  const unsubscribe = (listing: MarketListingSummary) => unsubscribeMut.mutate(listing.id);

  const subscribedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of subscriptions.data?.items ?? []) ids.add(item.listing_id);
    return ids;
  }, [subscriptions.data]);

  const warning = listQuery.data?.warning;
  const items = listQuery.data?.items ?? [];
  const hot = items.slice(0, 3);
  const latest = [...items]
    .sort((a, b) => (b.published_at ?? b.created_at ?? '').localeCompare(a.published_at ?? a.created_at ?? ''))
    .slice(0, 3);

  const resetMore = () => setVisible(PAGE_STEP);

  return (
    <div className="mx-auto flex w-full max-w-[1080px] flex-col gap-5 py-6">
      {warning ? (
        <div role="alert" className="rounded-tag border border-border bg-bg-muted px-3 py-2 text-aux text-text-secondary">
          ⚠ {warning}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <form
          className="relative min-w-[220px] max-w-[420px] flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            setKeyword(keywordInput.trim());
            resetMore();
          }}
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" aria-hidden />
          <Input
            className="pl-9"
            placeholder="搜索技能名称、描述或标签"
            maxLength={100}
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
          />
        </form>
        <Button
          size="md"
          variant="default"
          className="ml-auto"
          icon={<UserRound className="size-4" />}
          onClick={() => navigate('market', '?tab=personal')}
        >
          个人中心
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          className="w-36"
          placeholder="分类"
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            resetMore();
          }}
          options={MARKET_CATEGORIES.map((item) => ({ value: item, label: item }))}
        />
        <Select
          className="w-36"
          placeholder="类型"
          value={type}
          onChange={(event) => {
            setType(event.target.value);
            resetMore();
          }}
          options={SKILL_TYPE_OPTIONS}
        />
        <Select
          className="w-32"
          placeholder="评分"
          value={minRating}
          onChange={(event) => {
            setMinRating(event.target.value);
            resetMore();
          }}
          options={[
            { value: '4', label: '4 星以上' },
            { value: '3', label: '3 星以上' },
            { value: '2', label: '2 星以上' },
          ]}
        />
        <Select
          className="w-40"
          placeholder="兼容客户端"
          value={client}
          onChange={(event) => {
            setClient(event.target.value);
            resetMore();
          }}
          options={COMPATIBLE_CLIENTS.map((item) => ({ value: item, label: item }))}
        />
        <Select
          className="w-32"
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as MarketSort);
            resetMore();
          }}
          options={[
            { value: 'hot', label: '热门' },
            { value: 'new', label: '最新' },
            { value: 'rating', label: '评分' },
            { value: 'downloads', label: '订阅数' },
          ]}
        />
      </div>

      {listQuery.isPending ? (
        <div className="flex flex-col gap-3">
          <CardSkeleton count={3} />
        </div>
      ) : listQuery.isError ? (
        <EmptyState title="市场加载失败" description="请确认服务可用后重试" />
      ) : items.length === 0 ? (
        <EmptyState
          title="没有匹配的技能"
          description="换个关键词或放宽筛选条件试试"
        />
      ) : (
        <>
          {sort === 'hot' ? (
            <section className="flex flex-col gap-2.5">
              <p className="inline-flex items-center gap-1.5 text-section-title text-text-primary">
                🔥 热门
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {hot.map((item) => (
                  <MarketListingCard
                    key={item.id}
                    listing={item}
                    hot
                    subscribed={subscribedIds.has(item.id)}
                    onOpen={openListing}
                    onSubscribe={subscribe}
                    onUnsubscribe={unsubscribe}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="flex flex-col gap-2.5">
            <p className="inline-flex items-center gap-1.5 text-section-title text-text-primary">
              <Sparkles className="size-4 text-primary" aria-hidden />
              最新
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {latest.map((item) => (
                <MarketListingCard
                  key={`latest-${item.id}`}
                  listing={item}
                  subscribed={subscribedIds.has(item.id)}
                  onOpen={openListing}
                  onSubscribe={subscribe}
                  onUnsubscribe={unsubscribe}
                />
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2.5">
            <p className="inline-flex items-center gap-1.5 text-section-title text-text-primary">
              <Flame className="size-4 text-primary" aria-hidden />
              全部技能（{items.length}）
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {items.slice(0, visible).map((item) => (
                <MarketListingCard
                  key={`all-${item.id}`}
                  listing={item}
                  subscribed={subscribedIds.has(item.id)}
                  onOpen={openListing}
                  onSubscribe={subscribe}
                  onUnsubscribe={unsubscribe}
                />
              ))}
            </div>
            {visible < items.length ? (
              <Button
                className="self-center"
                variant="default"
                loading={listQuery.isFetching}
                onClick={() => setVisible((current) => current + PAGE_STEP)}
              >
                加载更多
              </Button>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
