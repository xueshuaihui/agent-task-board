import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useApiMutation } from '@/api';
import { marketApi } from './api';
import type { MarketListQuery } from './types';

/**
 * 市场 feature 的查询 key，独立前缀 `['market', ...]`（不进 src/api/keys.ts 的 qk，
 * 理由同 features/skills/hooks.ts：不改既有文件；WS 失效不覆盖市场——写操作自己失效）。
 */
export const marketKeys = {
  root: ['market'] as const,
  cloudStatus: () => ['market', 'cloud', 'status'] as const,
  list: (query?: MarketListQuery) => ['market', 'list', query ?? {}] as const,
  detail: (id: string) => ['market', 'detail', id] as const,
  subscriptions: () => ['market', 'subscriptions'] as const,
  myPublishes: () => ['market', 'me', 'publishes'] as const,
  myFeedbacks: () => ['market', 'me', 'feedbacks'] as const,
  myFavorites: () => ['market', 'me', 'favorites'] as const,
};

type Options = { enabled?: boolean };

export function useMarketListings(query?: MarketListQuery, options?: Options) {
  return useQuery({
    queryKey: marketKeys.list(query),
    queryFn: () => marketApi.list(query),
    enabled: options?.enabled,
  });
}

export function useMarketDetail(id: string | undefined, options?: Options) {
  return useQuery({
    queryKey: marketKeys.detail(id ?? ''),
    queryFn: () => marketApi.detail(id as string),
    enabled: Boolean(id) && (options?.enabled ?? true),
    retry: false,
  });
}

export function useMarketSubscriptions() {
  return useQuery({ queryKey: marketKeys.subscriptions(), queryFn: () => marketApi.subscriptions() });
}

export function useMyPublishes(options?: Options) {
  return useQuery({
    queryKey: marketKeys.myPublishes(),
    queryFn: () => marketApi.myPublishes(),
    enabled: options?.enabled ?? true,
  });
}

export function useMyFeedbacks() {
  return useQuery({ queryKey: marketKeys.myFeedbacks(), queryFn: () => marketApi.myFeedbacks() });
}

export function useMyFavorites() {
  return useQuery({ queryKey: marketKeys.myFavorites(), queryFn: () => marketApi.myFavorites() });
}

/* ---------------- 服务端市场（0919 对接层） ---------------- */

export function useCloudStatus(options?: Options) {
  return useQuery({
    queryKey: marketKeys.cloudStatus(),
    queryFn: () => marketApi.cloudStatus(),
    enabled: options?.enabled ?? true,
  });
}

export function useCloudConnect(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { url: string; username: string; password: string }) => marketApi.cloudConnect(vars),
    {
      invalidate: [marketKeys.cloudStatus(), ['settings']],
      onSuccess,
    },
  );
}

export function useCloudDisconnect(onSuccess?: () => void) {
  return useApiMutation(() => marketApi.cloudDisconnect(), {
    invalidate: [marketKeys.cloudStatus(), marketKeys.root, ['settings']],
    onSuccess,
  });
}

export function useMarketCloudPublish(onSuccess?: () => void) {
  return useApiMutation<Parameters<typeof marketApi.cloudPublish>[0], unknown>(marketApi.cloudPublish, {
    invalidate: [...rootInvalidate(), ['settings']],
    onSuccess,
  });
}

/** 写操作统一失效整棵市场子树：detail 里嵌着评论/收藏/订阅状态，逐 key 精确失效得不偿失。 */
function rootInvalidate(): readonly QueryKey[] {
  return [marketKeys.root];
}

export function useMarketPublish(onSuccess?: () => void) {
  return useApiMutation<Parameters<typeof marketApi.publish>[0], unknown>(marketApi.publish, {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

export function useMarketReview(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { id: string; action: 'approve' | 'reject'; reason?: string }) =>
      marketApi.review(vars.id, { action: vars.action, reason: vars.reason }),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useMarketDelist(onSuccess?: () => void) {
  return useApiMutation((id: string) => marketApi.delist(id), { invalidate: rootInvalidate(), onSuccess });
}

export function useMarketPublishVersion(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { id: string; skill_id: string }) => marketApi.publishVersion(vars.id, vars.skill_id),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useMarketSubscribe(onSuccess?: () => void) {
  return useApiMutation((id: string) => marketApi.subscribe(id), { invalidate: rootInvalidate(), onSuccess });
}

export function useMarketPullUpdate(onSuccess?: (version: string) => void) {
  return useApiMutation((id: string) => marketApi.pullUpdate(id), {
    invalidate: rootInvalidate(),
    onSuccess: (data) => onSuccess?.(data?.snapshot_version ?? ''),
  });
}

export function useMarketUnsubscribe(onSuccess?: () => void) {
  return useApiMutation((id: string) => marketApi.unsubscribe(id), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

export function useMarketRate(onSuccess?: () => void) {
  return useApiMutation((vars: { id: string; score: number }) => marketApi.rate(vars.id, vars.score), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

export function useMarketComment(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { id: string; content: string }) => marketApi.comment(vars.id, vars.content),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useMarketDeleteComment(onSuccess?: () => void) {
  return useApiMutation((commentId: string) => marketApi.deleteComment(commentId), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

export function useMarketToggleFavorite(onSuccess?: (favorited: boolean) => void) {
  return useApiMutation((id: string) => marketApi.toggleFavorite(id), {
    invalidate: rootInvalidate(),
    onSuccess: (data) => onSuccess?.(data?.favorited ?? false),
  });
}

export function useMarketReport(onSuccess?: () => void) {
  return useApiMutation((vars: { id: string; reason: string }) => marketApi.report(vars.id, vars.reason), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

export function useMarketCreateFeedback(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { id: string; title: string; content: string }) =>
      marketApi.createFeedback(vars.id, { title: vars.title, content: vars.content }),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useMarketRespondFeedback(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { feedbackId: string; response: string; resolution: 'fixed' | 'wontfix' }) =>
      marketApi.respondFeedback(vars.feedbackId, { response: vars.response, resolution: vars.resolution }),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useMarketVerifyFeedback(onSuccess?: () => void) {
  return useApiMutation(
    (vars: { feedbackId: string; confirmed: boolean }) =>
      marketApi.verifyFeedback(vars.feedbackId, vars.confirmed),
    { invalidate: rootInvalidate(), onSuccess },
  );
}
