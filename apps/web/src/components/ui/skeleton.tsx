import { cn } from '@/lib/cn';

/** 10.3 骨架屏：形状即布局，别用转圈代替（首屏布局跳动比转圈更难忍）。 */
export function Skeleton({
  className,
  lines,
}: {
  className?: string;
  /** 一次画 N 行（卡片/表格行用），给了就不看 className 的高度。 */
  lines?: number;
}) {
  if (lines !== undefined) {
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        {Array.from({ length: lines }, (_, index) => (
          <span
            key={index}
            className={cn(
              'block h-[14px] rounded-tag bg-bg-muted animate-shimmer',
              index === lines - 1 ? 'w-2/3' : 'w-full',
            )}
          />
        ))}
      </div>
    );
  }
  return <span className={cn('block rounded-tag bg-bg-muted animate-shimmer', className)} />;
}

/** 看板列的加载态：宽度按 3.1 的 280px 列、高度按 1.5 的卡片最小高 96px。 */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="min-h-24 w-full rounded-card p-3" lines={3} />
      ))}
    </div>
  );
}
