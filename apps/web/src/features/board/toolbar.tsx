import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ClipboardList, Plus, Settings2, X } from 'lucide-react';
import type { BoardView, Template } from '@/api/types';
import { api, qk, useSettings, useTags } from '@/api';
import { navigate } from '@/app/router';
import { useFilterStore } from '@/app/store/filters';
import { priorityText } from '@/lib/labels';
import { cn } from '@/lib/cn';
import { Button, Menu, MenuCaret, Tooltip, type MenuItem, type MenuProps } from '@/components/ui';
import { boardFilterCount, VIEW_ORDER } from './model';

/**
 * 3.4 工具栏：48px 高、左右 24px（沿用 `main` 的 padding），底边 1px。
 *
 * 两处刻意的「没有」：
 * - 没有「看板／列表」切换（3.4 末段：列表是独立的「任务」页，不是看板的另一种显示）；
 * - 没有「状态」chip（六列本身就是状态，再放一个多选会和列头互相矛盾）。
 *
 * 3.5 的筛选面板在 `components/` 里还没有共用实现，而看板没有筛选就等于
 * `toBoardQuery` 的四个参数全废，所以这里就地实现 chip 版（优先级／标签／类型 +
 * 依赖状态），读写的是与任务列表页同一份 `useFilterStore`（20.7 的 query key 也仍由
 * `toBoardQuery` 产出）。自定义字段组按 3.5 末行留到阶段二。
 *
 * 本文件另外导出 `CreateMenu`：3.8 任务列表页头部的那个下拉与这里是同一份规格，
 * 由 `features/task-list/create-menu.tsx` 直接复用（工具栏的视图段与筛选 chip 列表页不适用，
 * 所以复用只到下拉这一层）。
 */
export interface BoardToolbarProps {
  /** 打开快速新建；带 `template` 时用它预填（3.4 的模板下拉）。 */
  onCreate: (template?: Template) => void;
}

export function BoardToolbar({ onCreate }: BoardToolbarProps) {
  const view = useFilterStore((state) => state.view);
  const setView = useFilterStore((state) => state.setView);
  const reset = useFilterStore((state) => state.reset);
  const filters = useFilterStore();
  const conditions = useMemo(() => boardFilterCount(filters), [filters]);
  const count = conditions + (view === 'all' ? 0 : 1);
  const viewLabel = VIEW_ORDER.find((item) => item.view === view)?.label ?? '全部';

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border">
      <ViewSegmented value={view} onChange={setView} />

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PriorityChip />
        <TagChip />
        <TypeChip />
        <DependencyChip />
        {count > 0 ? (
          // 3.4「视图生效时的列表现」：空列折叠与这句文案同时出现，防止误读成"看板挂了"。
          <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-aux text-text-secondary">
            视图：{viewLabel}
            {conditions > 0 ? ` · 已筛 ${conditions} 项` : ''}
            <Tooltip content="复位为「全部」并清空筛选">
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-0.5 rounded-tag px-1 text-primary hover:bg-primary-light"
              >
                <X className="size-3.5" aria-hidden />
                清除全部
              </button>
            </Tooltip>
          </span>
        ) : null}
      </div>

      <CreateMenu onCreate={onCreate} />
    </div>
  );
}

/* ------------------------------------------------------------- 视图预设 */

function ViewSegmented({ value, onChange }: { value: BoardView; onChange: (view: BoardView) => void }) {
  return (
    <div role="group" aria-label="视图预设" className="flex shrink-0 items-center gap-1">
      <span className="mr-1 text-aux text-text-tertiary">视图</span>
      {VIEW_ORDER.map((item) => {
        const active = item.view === value;
        return (
          <button
            key={item.view}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.view)}
            className={cn(
              'h-7 shrink-0 rounded-control border px-2.5 text-body transition-colors duration-120 ease-out',
              active
                ? 'border-border-strong bg-bg-surface text-primary'
                : 'border-transparent text-text-secondary hover:bg-bg-muted hover:text-text-primary',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- 筛选 chip */

type ChipKey = 'priority' | 'type' | 'tags';

function useChipItems<T extends string | number>(
  key: ChipKey,
  options: readonly { value: T; label: string }[],
): { items: MenuItem[]; selected: number } {
  const raw = useFilterStore((state) => state[key]) as readonly (string | number)[];
  const toggleNumber = useFilterStore((state) => state.toggleNumber);
  const toggleString = useFilterStore((state) => state.toggleString);
  const items: MenuItem[] = options.map((option) => ({
    id: String(option.value),
    label: option.label,
    icon: raw.includes(option.value) ? <Check className="size-3.5 text-primary" /> : undefined,
    onSelect: () => {
      if (key === 'priority' && typeof option.value === 'number') toggleNumber('priority', option.value);
      if (key === 'type' && typeof option.value === 'string') toggleString('type', option.value);
      if (key === 'tags' && typeof option.value === 'string') toggleString('tags', option.value);
    },
  }));
  return { items, selected: raw.length };
}

interface ChipProps {
  label: string;
  selected: number;
  groups: MenuProps['groups'];
  selectedId?: string;
  width?: number;
}

function Chip({ label, selected, groups, selectedId, width = 180 }: ChipProps) {
  return (
    <Menu
      width={width}
      groups={groups}
      selectedId={selectedId}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body transition-colors duration-120 ease-out',
            selected > 0
              ? 'border-primary bg-primary-light text-primary'
              : 'border-border text-text-secondary hover:bg-bg-muted hover:text-text-primary',
          )}
        >
          {label}
          {selected > 0 ? (
            <span className="rounded-badge bg-primary px-1 text-badge text-text-inverse">{selected}</span>
          ) : null}
          <MenuCaret open={open} />
        </button>
      )}
    />
  );
}

function PriorityChip() {
  const options = useMemo(() => [0, 1, 2, 3].map((value) => ({ value, label: priorityText(value) })), []);
  const { items, selected } = useChipItems('priority', options);
  return <Chip label="优先级" selected={selected} groups={items} />;
}

function TagChip() {
  const tags = useTags();
  // 词表来自 20.7 `/tags`（含历史值），超过 30 个时靠菜单自身的滚动。
  const options = useMemo(
    () => (tags.data?.tags ?? []).slice(0, 30).map((tag) => ({ value: tag, label: tag })),
    [tags.data?.tags],
  );
  const { items, selected } = useChipItems('tags', options);
  return (
    <Chip
      label="标签"
      selected={selected}
      groups={options.length === 0 ? [{ id: 'no-tag', label: '暂无标签', disabled: true }] : items}
      width={200}
    />
  );
}

function TypeChip() {
  const settings = useSettings();
  const options = useMemo(
    () => (settings.data?.task_types ?? []).map((type) => ({ value: type, label: type })),
    [settings.data?.task_types],
  );
  const { items, selected } = useChipItems('type', options);
  return <Chip label="类型" selected={selected} groups={items} />;
}

/** 3.5「依赖状态」组：与 `view` 是同一参数的两种写法，所以这里只改 view，不多发一份。 */
function DependencyChip() {
  const view = useFilterStore((state) => state.view);
  const setView = useFilterStore((state) => state.setView);
  const groups: MenuProps['groups'] = [
    {
      label: '依赖状态',
      items: [
        { id: 'all', label: '全部', onSelect: () => setView('all') },
        { id: 'claimable', label: '仅可领取', hint: '同步视图', onSelect: () => setView('claimable') },
        { id: 'blocked', label: '仅已阻塞', hint: '同步视图', onSelect: () => setView('blocked') },
      ],
    },
  ];
  const selected = view === 'claimable' || view === 'blocked' ? 1 : 0;
  return <Chip label="更多" selected={selected} groups={groups} selectedId={view} width={180} />;
}

/* ---------------------------------------------------------- 新建入口 */

/** 3.4：模板最多 6 条，超出走「管理模板…」。 */
const TEMPLATE_LIMIT = 6;

function useTemplates(): Template[] {
  const query = useQuery({
    queryKey: qk.templates(),
    queryFn: () => api.templates.list(),
    staleTime: 30_000,
  });
  /** 服务端已按 `sort_order` 排好；模板没有启停，所以这里只截断条数。 */
  return useMemo(() => (query.data?.items ?? []).slice(0, TEMPLATE_LIMIT), [query.data?.items]);
}

export interface CreateMenuProps {
  /**
   * 只回「用户选了什么」：`undefined` = 空白任务，否则为所选模板。
   * 弹窗与写操作留在各自的页面里（3.4 的看板与 3.8 的列表页都用自己的 `QuickCreateDialog`），
   * 下拉本身不持有对话框，否则两处 8.1 的差异（列表页额外要 `mutations`）会挤进同一个组件。
   */
  onCreate: (template?: Template) => void;
}

/**
 * 3.4「新建任务下拉」：`＋ 新建任务 ▾` = 空白任务 / 从模板（最多 6 条，无模板时该项 disabled）
 * / 管理模板…（跳设置页 templates Tab）。
 *
 * 导出给 3.8 的任务列表页头部复用：两处是同一份规格（各自都是「本栏唯一的创建入口」），
 * 复制一份出来迟早漂——PRD 2368 的警告就是这个。查询走同一个 `qk.templates()`，两页共享缓存。
 * `data-testid` 固定为 `create-task`：`app.tsx` 的 `PAGES` 一次只挂一页，两个入口不会同时进 DOM。
 */
export function CreateMenu({ onCreate }: CreateMenuProps) {
  const templates = useTemplates();
  const groups: MenuProps['groups'] = [
    {
      items: [
        {
          id: 'blank',
          label: '空白任务',
          icon: <Plus className="size-3.5" aria-hidden />,
          onSelect: () => onCreate(),
        },
      ],
    },
    {
      label: '从模板',
      items:
        templates.length === 0
          ? [{ id: 'no-template', label: '暂无模板', disabled: true }]
          : templates.map((template) => ({
              id: template.id,
              label: template.name,
              icon: <ClipboardList className="size-3.5" aria-hidden />,
              onSelect: () => onCreate(template),
            })),
    },
    {
      items: [
        {
          id: 'manage',
          label: '管理模板…',
          icon: <Settings2 className="size-3.5" aria-hidden />,
          onSelect: () => navigate('settings', '?tab=templates'),
        },
      ],
    },
  ];

  return (
    <Menu
      align="end"
      width={220}
      groups={groups}
      trigger={({ open, toggle }) => (
        <Button
          variant="primary"
          className="h-8 shrink-0"
          aria-expanded={open}
          icon={<Plus className="size-4" aria-hidden />}
          onClick={toggle}
          data-testid="create-task"
        >
          新建任务
          <MenuCaret open={open} />
        </Button>
      )}
    />
  );
}
