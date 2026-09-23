import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PanelLeftClose, SlidersHorizontal } from 'lucide-react';
import { Drawer, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { GROUP_DIMENSIONS, type GroupDimensionKey, type GroupableTask } from './dimensions';
import {
  FILTERABLE_DIMENSIONS,
  hasActiveFilter,
  slotStats,
  type FilterSlot,
  type FilterSlotId,
} from './filter-model';
import { useBoardFilterStore } from './useBoardFilterStore';

/** 折叠偏好键：只影响本侧栏占不占位，不进过滤偏好（board.filter）本体。 */
const RAIL_COLLAPSED_KEY = 'atb.board.filter.collapsed';
/** globals.css `--breakpoint-win-lg`，JS 侧唯一需要断点数值的地方。 */
const WIN_LG_QUERY = '(min-width: 1200px)';

function readRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * B13 分组过滤侧栏：两个维度槽（A/B）各自「维度选择 + 值多选」，
 * 徽标行给出 总数 / 执行中 / 待审核，点选即过滤、再点取消。
 * ≥win-lg 默认内联在列区左侧、可手动折叠；窄窗或折叠后收成竖轨：
 * ≥win-lg 点竖轨展开侧栏，窄窗点竖轨开抽屉。
 */
export function GroupFilterSidebar({ tasks }: { tasks: readonly GroupableTask[] }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readRailCollapsed);
  const [wide, setWide] = useState(() => window.matchMedia(WIN_LG_QUERY).matches);
  const active = useBoardFilterStore(
    useShallow((state) => hasActiveFilter({ slotA: state.slotA, slotB: state.slotB })),
  );

  useEffect(() => {
    const mq = window.matchMedia(WIN_LG_QUERY);
    const onChange = (event: MediaQueryListEvent) => setWide(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleCollapsed = (next: boolean): void => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // 写失败仅丢偏好，不提示。
    }
  };

  const onRailClick = (): void => {
    // 窄窗竖轨点击开抽屉；≥win-lg（侧栏被手动折叠）点击展开侧栏。
    if (wide) {
      toggleCollapsed(false);
    } else {
      setDrawerOpen(true);
    }
  };

  return (
    <>
      <div className={cn('flex w-9 shrink-0 flex-col items-center border-r border-border pt-2', !collapsed && 'win-lg:hidden')}>
        <button
          type="button"
          aria-label={collapsed && wide ? '展开分组侧栏' : '打开分组过滤'}
          onClick={onRailClick}
          className="relative rounded-control p-1.5 text-text-secondary hover:bg-bg-muted hover:text-text-primary"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          {active ? (
            <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
          ) : null}
        </button>
      </div>
      <aside
        className={cn(
          'atb-scroll hidden w-56 shrink-0 flex-col overflow-y-auto border-r border-border px-3 pb-3 pt-2',
          !collapsed && 'win-lg:flex',
        )}
      >
        <div className="mb-1 flex items-center justify-end">
          <button
            type="button"
            aria-label="折叠分组侧栏"
            onClick={() => toggleCollapsed(true)}
            className="rounded-control p-1.5 text-text-secondary hover:bg-bg-muted hover:text-text-primary"
          >
            <PanelLeftClose className="size-4" aria-hidden />
          </button>
        </div>
        <FilterPanel tasks={tasks} />
      </aside>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="分组过滤"
        className="w-72 win-lg:w-72 win-xl:w-72"
      >
        <FilterPanel tasks={tasks} />
      </Drawer>
    </>
  );
}

function FilterPanel({ tasks }: { tasks: readonly GroupableTask[] }) {
  const slotA = useBoardFilterStore((state) => state.slotA);
  const slotB = useBoardFilterStore((state) => state.slotB);
  return (
    <div className="flex flex-col gap-5">
      <SlotSection id="slotA" slot={slotA} tasks={tasks} otherDim={slotB.dim} />
      <SlotSection id="slotB" slot={slotB} tasks={tasks} otherDim={slotA.dim} />
    </div>
  );
}

function SlotSection({
  id,
  slot,
  tasks,
  otherDim,
}: {
  id: FilterSlotId;
  slot: FilterSlot;
  tasks: readonly GroupableTask[];
  otherDim: GroupDimensionKey;
}) {
  const setSlotDim = useBoardFilterStore((state) => state.setSlotDim);
  const toggleValue = useBoardFilterStore((state) => state.toggleValue);
  const clearSlot = useBoardFilterStore((state) => state.clearSlot);

  // 两槽不选同一维度：另一槽占用的维度从候选里去掉。
  const options = [
    { value: 'none', label: id === 'slotA' ? '分组维度…' : '叠加维度：无' },
    ...FILTERABLE_DIMENSIONS.filter((key) => key !== otherDim).map((key) => ({
      value: key,
      label: GROUP_DIMENSIONS[key].label,
    })),
  ];
  const stats = slot.dim === 'none' ? [] : slotStats(tasks, slot.dim);
  const selectedSet = new Set(slot.values);

  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5">
        <Select
          className="h-7 min-w-0 flex-1 text-body"
          aria-label={id === 'slotA' ? '主过滤维度' : '叠加过滤维度'}
          value={slot.dim}
          onChange={(event) => setSlotDim(id, event.target.value as GroupDimensionKey)}
          options={options}
        />
        {slot.values.length > 0 ? (
          <button
            type="button"
            onClick={() => clearSlot(id)}
            className="shrink-0 rounded-tag px-1.5 py-0.5 text-aux text-text-secondary hover:bg-bg-muted hover:text-text-primary"
          >
            清除
          </button>
        ) : null}
      </div>

      {slot.dim === 'none' ? null : stats.length === 0 ? (
        <p className="px-2 py-1 text-aux text-text-tertiary">暂无分组值</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {stats.map((stat) => {
            const selected = selectedSet.has(stat.key);
            return (
              <li key={stat.key}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleValue(id, stat.key)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-control px-2 py-1 text-body transition-colors duration-140 ease-settle',
                    selected
                      ? 'bg-primary-light text-primary'
                      : 'text-text-secondary hover:bg-bg-muted hover:text-text-primary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{stat.label}</span>
                  {stat.running > 0 ? (
                    <span title="执行中" className="text-badge tabular-nums text-status-running">
                      ▶{stat.running}
                    </span>
                  ) : null}
                  {stat.review > 0 ? (
                    <span title="待审核" className="text-badge tabular-nums text-status-review">
                      审{stat.review}
                    </span>
                  ) : null}
                  <span className="text-badge tabular-nums text-text-tertiary">{stat.total}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
