import { motion, useReducedMotion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { Badge, Card, TagBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { priorityText } from '@/lib/labels';
import { priorityStyle } from '@/lib/status-style';
import { transitions } from '@/lib/motion';
import { skillStatusOf, type AnnotatedDraft } from './skill-status';

/**
 * §7.3「已识别任务」草案卡 / §7.2 阶段 4：Agent 每上报一条草案，卡片淡入追加。
 *
 * 技能标注口径（§7.5 r3 + 条款 81）：GET 详情的 `skills_status` 给出逐条解析态——
 * `ambiguous`（同名多技能，服务端默认取了最近更新者）黄色告警 + 候选提示，
 * `unresolved`（查无此技能）保留 Agent 原值黄色告警；两者都**不阻断创建**，
 * 改选入口在编辑面板（卡片点击即打开）。无标注（写回执乐观窗口）退回旧口径：
 * 技能表已加载而 id 查不到 name → 按未解析显。
 */
export interface DraftCardProps {
  draft: AnnotatedDraft;
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
              const status = skillStatusOf(draft, value);
              if (status?.state === 'ambiguous') {
                // 条款 81：同名多技能——警示态 + hover 列候选，点卡片进面板改选。
                const candidates = status.candidates
                  .map((id) => skillNames?.get(id) ?? `…${id.slice(-6)}`)
                  .join('、');
                return (
                  <Badge
                    key={value}
                    className="bg-status-review-soft text-status-review"
                    icon={<AlertTriangle className="size-3" aria-hidden />}
                  >
                    <span title={`同名技能 ${status.candidates.length} 个（${candidates}），已默认绑定最近更新者；点击卡片可在编辑面板改选`}>
                      歧义技能 · {status.name}
                    </span>
                  </Badge>
                );
              }
              if (status?.state === 'unresolved') {
                return (
                  <Badge
                    key={value}
                    className="bg-status-review-soft text-status-review"
                    icon={<AlertTriangle className="size-3" aria-hidden />}
                  >
                    未解析技能 · {status.name}
                  </Badge>
                );
              }
              if (status) {
                // resolved：服务端已给出 name，不再依赖本地技能表。
                return <TagBadge key={value}>{status.name}</TagBadge>;
              }
              const known = skillNames?.get(value);
              if (skillNames && !known) {
                // 未解析（无标注窗口的旧口径）：保留 Agent 原值 + 黄色告警（§7.5「不阻断创建」）。
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
