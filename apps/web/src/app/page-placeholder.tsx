import { Card, CardBody, CardHeader, Badge } from '@/components/ui';

export interface PagePlaceholderProps {
  /** 页面名，与 2.2 导航项一致。 */
  title: string;
  /** 对应的原型章节，交给实现方去读，如「三（3.1–3.7）」。 */
  spec: string;
  /** 由哪个后续任务实现。 */
  owner: string;
  /** 基座已经为该页准备好的东西与必须遵守的约定。 */
  points: readonly string[];
}

/**
 * 基座交付时的占位面板：说清「这块归谁、已经有什么、必须怎么用」。
 * 每个 feature 实现后连这个组件一起删掉，不留半成品 UI。
 */
export function PagePlaceholder({ title, spec, owner, points }: PagePlaceholderProps) {
  return (
    <Card className="flex min-h-0 w-full max-w-[720px] flex-col">
      <CardHeader className="justify-between">
        <span className="text-section-title text-text-primary">{title}</span>
        <Badge tone="neutral">
          由 {owner} 实现 · 原型 {spec}
        </Badge>
      </CardHeader>
      <CardBody className="atb-scroll min-h-0 overflow-y-auto">
        <p className="text-aux text-text-secondary">本页当前是基座占位，不含业务逻辑。</p>
        <ul className="mt-3 flex flex-col gap-2">
          {points.map((point) => (
            <li
              key={point}
              data-selectable
              className="flex gap-2 text-body text-text-primary"
            >
              <span aria-hidden className="mt-[10px] size-1.5 shrink-0 rounded-full bg-border-strong" />
              <span className="min-w-0 flex-1">{point}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
