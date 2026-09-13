import { Bell, Diamond } from 'lucide-react';
import { api, qk, useApiMutation, useNotifications } from '@/api';
import { useUnreadStore, badgeText } from '@/app/store/unread';
import { taskListSearch } from '@/app/store/filters';
import { navigate, NAV_ORDER, ROUTES, useRoute } from '@/app/router';
import { IconButton } from '@/components/ui';
import { useUnreadCount } from '@/ws';
import { cn } from '@/lib/cn';

/**
 * 2.2 顶栏：Logo + 应用名 / 四个导航项 / 一个通知铃铛。
 *
 * 三条刻意的「不做」（原型 2.2 末段）：不放依赖图入口（阶段二，见 lib/phase.ts）、
 * 不放全局筛选器、不放全局搜索框——筛选是页面级状态（app/store/filters.ts 一份真值），
 * 搜索属于任务列表页。全栏只有铃铛这一个角标：「审核」导航项再挂待审核数就会出现
 * 两个清零条件不同的数字。
 *
 * 铃铛只随 `notification.created` 变化：计数由服务端在事件载荷里算好，
 * 在 `src/ws/invalidate.ts` 一处写进 unread store（看板/列表响应也带同一个数），
 * 所以这里不再订阅第二次、也不轮询。
 */
export function TopBar() {
  const route = useRoute();
  const count = useUnreadCount();
  const badge = badgeText(count);

  // 未读数的首值来源（2.2 角标 = GET /notifications 的 unread_count）；面板列表属阶段二。
  useNotifications({ unread: true }, { staleTime: 60_000 });

  const clearReviewPending = useApiMutation<undefined, number>(
    () => api.notifications.markReviewPendingRead(),
    {
      invalidate: [qk.notificationsRoot, qk.boardRoot],
      onSuccess: (updated) => {
        // 先把角标按已清理的条数回落（等 /board 回来要一个往返），真值随后由失效查询校准。
        if (updated > 0) useUnreadStore.getState().bump(-updated);
      },
    },
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-6 border-b border-border bg-bg-surface pl-6 pr-4">
      <div className="flex shrink-0 items-center gap-2">
        <Diamond className="size-6 shrink-0 text-primary" aria-hidden />
        <span className="text-logo text-text-primary">Agent Task Board</span>
      </div>

      <nav aria-label="主导航" className="flex h-full min-w-0 flex-1 items-stretch gap-6">
        {NAV_ORDER.map((name) => {
          const active = route.name === name;
          return (
            <button
              key={name}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(name)}
              className={cn(
                'inline-flex items-center border-b-2 border-transparent text-nav transition-colors duration-120 ease-out',
                active
                  ? 'border-primary text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {ROUTES[name].label}
            </button>
          );
        })}
      </nav>

      <div className="relative shrink-0">
        <IconButton
          label="未读通知"
          icon={<Bell className="size-6" aria-hidden />}
          onClick={() => {
            // 2.2：不展开面板，直接跳「待审核」筛选视图，并把对应通知标已读。
            navigate('tasks', taskListSearch({ status: 'REVIEW' }));
            if (count > 0) clearReviewPending.mutate();
          }}
        />
        {badge ? (
          <span className="pointer-events-none absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-badge bg-status-review px-[5px] text-badge text-text-inverse">
            {badge}
          </span>
        ) : null}
      </div>
    </header>
  );
}
