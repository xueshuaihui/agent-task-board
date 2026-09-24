import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';
import { useSettings, useTags } from '@/api';
import type { TaskCard } from '@/api/types';
import { useFilterStore } from '@/app/store/filters';
import {
  FILTER_DIMENSIONS,
  deriveFilterOptions,
  optionLabel,
  selectedValues,
  setFilterDimension,
} from './options';

/**
 * B15-③：已激活过滤条件的汇总条（结果区上方，Linear 式）。
 * 一条条件一枚 chip、✕ 单删；「清除全部」仍在看板工具栏（那里同时复位视图段）。
 */
export function FilterChipsBar({ cards }: { cards: readonly TaskCard[] }) {
  const filters = useFilterStore(
    useShallow((state) => ({
      requirements: state.requirements,
      type: state.type,
      priority: state.priority,
      agents: state.agents,
      tags: state.tags,
    })),
  );
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

  const chips = useMemo(
    () =>
      FILTER_DIMENSIONS.flatMap((dimension) =>
        selectedValues(filters, dimension.key).map((value) => ({
          dim: dimension.key,
          value,
          // 派生候选回显不了裸值时（数据已不可见）也保留 chip——可删比好看重要。
          text: `${dimension.label}：${optionLabel(options[dimension.key], value)}`,
        })),
      ),
    [filters, options],
  );

  if (chips.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 pb-1 pt-2" aria-label="已激活的筛选条件">
      {chips.map((chip) => (
        <button
          key={`${chip.dim}:${chip.value}`}
          type="button"
          title={`移除条件：${chip.text}`}
          onClick={() =>
            setFilterDimension(
              chip.dim,
              selectedValues(filters, chip.dim).filter((value) => value !== chip.value),
            )
          }
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-tag border border-primary bg-primary-light px-1.5 text-badge text-primary transition-colors duration-140 ease-settle hover:text-primary-hover"
        >
          {chip.text}
          <X className="size-3" aria-hidden />
        </button>
      ))}
    </div>
  );
}
