import { motion, useReducedMotion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import type { BreakdownDraft } from '@/api/types';
import { Badge, Card, TagBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { priorityText } from '@/lib/labels';
import { priorityStyle } from '@/lib/status-style';
import { transitions } from '@/lib/motion';

/**
 * §7.3「已识别任务」草案卡 / §7.2 阶段 4：Agent 每上报一条草案，卡片淡入追加。
 *
 * 技能标注口径（§7.5 r3）：服务端 `finish_breakdown` 已把可解析的技能名统一转 id，
 * GET 详情里剩下的**非 id 值**即「无法解析」的原始名——黄色告警、不阻断创建
 * （歧义报告只随 finish 的 MCP 回包给 Agent，REST 载荷没有，故前端只做未解析检测）。
 */
export interface DraftCardProps {
  draft: BreakdownDraft;
  /** 技能 id → name（全量技能表已加载时给；null = 未加载，技能标签按原值灰显、不判未解析）。 */
  skillNames: Map<string, string> | null;
}

export function DraftCard({ draft, skillNames }: DraftCardProps) {
  const reduced = useReducedMotion();
  const priority = priorityStyle(draft.priority);

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.rise}
      data-testid="breakdown-draft-card"
    >
      <Card className="flex h-full flex-col gap-2 p-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 font-mono text-code text-text-tertiary">#{draft.ref}</span>
          <p className="min-w-0 flex-1 truncate text-card-title text-text-primary" title={draft.title}>
            {draft.title}
          </p>
          <Badge
            className={cn('shrink-0', priority.soft, priority.text)}
            icon={<span className={cn('size-1.5 rounded-full', priority.dot)} aria-hidden />}
          >
            {priorityText(draft.priority)}
          </Badge>
        </div>

        {draft.description ? (
          <p className="line-clamp-2 text-aux text-text-secondary" title={draft.description}>
            {draft.description}
          </p>
        ) : null}

        {draft.skill_ids.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {draft.skill_ids.map((value) => {
              const known = skillNames?.get(value);
              if (skillNames && !known) {
                // 未解析：保留 Agent 原值 + 黄色告警（§7.5「不阻断创建」）。
                return (
                  <Badge
                    key={value}
                    className="bg-status-review-soft text-status-review"
                    icon={<AlertTriangle className="size-3" aria-hidden />}
                  >
                    未解析技能 · {value}
                  </Badge>
                );
              }
              return <TagBadge key={value}>{known ?? value}</TagBadge>;
            })}
          </div>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-1">
          {draft.depends_on.length > 0 ? (
            <Badge tone="neutral">依赖 {draft.depends_on.map((ref) => `#${ref}`).join('、')}</Badge>
          ) : null}
          {draft.acceptance.length > 0 ? (
            <span title={draft.acceptance.join('\n')} className="inline-flex">
              <Badge tone="neutral">验收 {draft.acceptance.length} 项</Badge>
            </span>
          ) : null}
        </div>
      </Card>
    </motion.div>
  );
}
