import { useMemo, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useSettings, useTags } from '@/api';
import type { TaskCard } from '@/api/types';
import { useFilterStore } from '@/app/store/filters';
import { cn } from '@/lib/cn';
import { ChipGroup, ErrorText, Popover } from '@/components/ui';
import { boardFilterCount } from '../model';
import {
  FILTER_DIMENSIONS,
  deriveFilterOptions,
  selectedValues,
  setFilterDimension,
} from './options';

/**
 * B15-③：工具栏唯一的过滤入口——「筛选」按钮 + 弹层（Linear 式）。
 * 取代旧的 GroupSwitcher / 优先级 / 标签 / 类型 / 「更多」五个分散控件；
 * 已激活条件由结果区上方的 `FilterChipsBar` 逐条可删地呈现。
 */
export function FilterMenu({ cards }: { cards: readonly TaskCard[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const filters = useFilterStore();
  const conditions = useMemo(() => boardFilterCount(filters), [filters]);

  const settings = useSettings();
  const tags = useTags();
  const options = useMemo(
    () =>
      deriveFilterOptions({
        cards,
        types: settings.data?.task_types ?? [],
        tags: tags.data?.tags ?? [],
      }),
    [cards, settings.data?.task_types, tags.data?.tags],
  );
  /* tier-2（2026-09-29「列表报错被渲染成空状态」）：两词表各自都可能 500，各说一行——
   * `deriveFilterOptions` 与看板快照取并集，所以这里没有「没有标签」那种假话，
   * 但候选会静默收缩成"只剩当前卡片上出现的值"，这层降级必须显形。 */
  const vocabularyDegraded = settings.isError || tags.isError;

  const anchor = (
    <button
      ref={anchorRef}
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={() => setOpen((value) => !value)}
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body transition-colors duration-140 ease-settle',
        conditions > 0
          ? 'border-primary bg-primary-light text-primary'
          : 'border-border text-text-secondary hover:bg-bg-muted hover:text-text-primary',
      )}
    >
      <SlidersHorizontal className="size-3.5" aria-hidden />
      筛选
      {conditions > 0 ? (
        <span className="rounded-badge bg-primary px-1 text-badge text-text-inverse tabular-nums">
          {conditions}
        </span>
      ) : null}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      anchor={anchor}
      align="start"
      side="bottom"
      sideOffset={6}
      contentWidth={560}
      ariaLabel="筛选条件"
      className="max-h-[70vh] overflow-y-auto p-3"
      // 点锚点按钮自身的收合交给 onClick toggle：不挡下 dismiss 会「关了又开」。
      onInteractOutside={(event) => {
        if (anchorRef.current && anchorRef.current.contains(event.target as Node)) {
          event.preventDefault();
        }
      }}
    >
      {/* 维内 OR、维间 AND（与 /board 服务端语义同一句话）。 */}
      <div className="flex flex-col gap-3">
        {FILTER_DIMENSIONS.map((dimension) => (
          <ChipGroup
            key={dimension.key}
            label={dimension.label}
            aria-label={`${dimension.label}筛选`}
            options={options[dimension.key]}
            selected={selectedValues(filters, dimension.key)}
            onChange={(next) => setFilterDimension(dimension.key, next)}
          />
        ))}
        {/* 词表降级说明（见上方 `vocabularyDegraded`）：已选值仍可见可删、五维照常可点，只补行说明。 */}
        {vocabularyDegraded ? (
          <div className="flex flex-col gap-1 text-status-failed">
            {settings.isError ? (
              <ErrorText text="类型词表加载失败，候选只剩当前看板卡片里的类型" error={settings.error} />
            ) : null}
            {tags.isError ? (
              <ErrorText text="标签词表加载失败，候选只剩当前看板卡片里的标签" error={tags.error} />
            ) : null}
          </div>
        ) : null}
      </div>
    </Popover>
  );
}
