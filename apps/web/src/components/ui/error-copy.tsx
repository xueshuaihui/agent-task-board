import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { errorMessage, errorDetailOf } from '@/api/errors';
import { cn } from '@/lib/cn';

/**
 * 错误呈现的两件套（2026-09-29「报错全部细化」拍板②）：
 * 主行 = 「现在怎么办」（服务端 message 优先，缺失才回落到本地码表）；
 * 折叠 = 「到底怎么了」（`context.detail`，引擎原文一行）。
 *
 * 为什么单独抽出来：Toast 之外还有一大片**就地显示**的错误面（看板 / 列表 / 需求 / 审核 /
 * 任务详情的每个 tab / 设置页各 tab），它们以前直接写 `error.message`——那既绕开了码表兜底，
 * 也让认不出的错误把内部话术「服务内部错误」原样糊在界面上。统一走这里，一处改处处生效。
 */

export interface ErrorDetailProps {
  /** 引擎原文；空串 / undefined 时整个入口不渲染（不摆一个点了没反应的按钮）。 */
  text?: string;
  className?: string;
}

/** 「详情 / 收起详情」那一行 + 展开后的等宽原文。与 Toast 里的是同一份实现。 */
export function ErrorDetail({ text, className }: ErrorDetailProps) {
  const [open, setOpen] = useState(false);
  const detail = text?.trim() ?? '';
  if (!detail) return null;
  return (
    <span className={cn('mt-1 block', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 text-aux text-text-tertiary hover:text-text-secondary"
      >
        <ChevronRight
          className={cn('size-3 transition-transform duration-140 ease-settle', open && 'rotate-90')}
        />
        {open ? '收起详情' : '详情'}
      </button>
      {open ? (
        <span className="mt-1 block break-all font-mono text-aux text-text-tertiary" data-selectable>
          {detail}
        </span>
      ) : null}
    </span>
  );
}

/** 就地错误面的一整块：细化文案 + 有原文时才有的折叠入口。 */
export function ErrorCopy({ error, className }: { error: unknown; className?: string }) {
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="block">{errorMessage(error)}</span>
      <ErrorDetail text={errorDetailOf(error)} />
    </span>
  );
}

/** 需要自己拼前后缀时（比如「保存失败：」）用这一对，保证文案口径仍来自 `errorMessage`。 */
export function ErrorLine({
  prefix,
  error,
  className,
}: {
  prefix?: ReactNode;
  error: unknown;
  className?: string;
}): ReactNode {
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="block">
        {prefix}
        {errorMessage(error)}
      </span>
      <ErrorDetail text={errorDetailOf(error)} />
    </span>
  );
}

/**
 * 主行文案**已经被本地拼过**时用的那一版（422 把逐字段问题并进一句、依赖环换成 4.5 的
 * 统一话术、图片的 ARTIFACT_LOST 换成灰态口径……）。
 *
 * 这些地方不能直接用 `<ErrorCopy>`：它会把拼好的句子换成 `errorMessage`，拼进去的信息就丢了。
 * 所以主行照旧给 `text`，折叠仍给原始错误的引擎原文——细化文案与折叠详情两行都在，
 * 只是第一行由调用方负责。`detail` 传原始 error，由 `errorDetailOf` 取，调用方不必自己摸 `context`。
 */
export function ErrorText({
  text,
  error,
  detail,
  className,
}: {
  text: ReactNode;
  /** 原始错误对象（取折叠详情用）。 */
  error?: unknown;
  /** 已经抽好的详情；与 `error` 二选一，`detail` 优先。 */
  detail?: string;
  className?: string;
}) {
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="block">{text}</span>
      <ErrorDetail text={detail ?? errorDetailOf(error)} />
    </span>
  );
}
