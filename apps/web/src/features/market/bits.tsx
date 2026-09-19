import { Star } from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { SKILL_TYPE_META } from '@/features/skills/meta';
import type { SkillType } from '@/features/skills/types';
import type { MarketSource } from './types';

/** 市场各页共用的小展示件：来源徽标 / 类型标签 / 评分星。 */

/** 来源徽标：官方 builtin / 市场 published / 服务端 cloud（1.md 9.2 + 0919 服务端市场）。 */
export function SourceBadge({ source }: { source: MarketSource }) {
  if (source === 'builtin') return <Badge className="bg-primary-light text-primary">官方</Badge>;
  if (source === 'cloud') return <Badge className="bg-primary-light text-primary">☁ 服务端</Badge>;
  return <Badge>市场</Badge>;
}

/** 类型标签（复用技能库的类型词表与文案）。 */
export function TypeLabel({ type }: { type: string }) {
  return <Badge>{SKILL_TYPE_META[type as SkillType]?.label ?? type}</Badge>;
}

/** 类型首字图标（同 skill-card 的方块首字）。 */
export function TypeAvatar({ name, type }: { name: string; type: string }) {
  const known = Boolean(SKILL_TYPE_META[type as SkillType]);
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-tag text-body',
        known ? 'bg-primary-light text-primary' : 'bg-bg-muted text-text-secondary',
      )}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 评分星：整星/半星不做，按四舍五入亮星（简化版，1.md 9.2 未规定精确到半星）。 */
export function RatingStars({ value, count, className }: { value: number; count?: number; className?: string }) {
  const rounded = Math.round(value);
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 text-aux text-text-tertiary', className)}
      title={count === undefined ? `${value.toFixed(1)} 分` : `${value.toFixed(1)} 分 · ${count} 人评分`}
    >
      <span className="inline-flex" aria-hidden>
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={cn('size-3.5', star <= rounded ? 'fill-status-review text-status-review' : 'text-text-tertiary')}
          />
        ))}
      </span>
      <span className="tabular-nums">{value > 0 ? value.toFixed(1) : '暂无'}</span>
    </span>
  );
}
