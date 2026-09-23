import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Kanban, List, Network, Plus, Settings2, X } from 'lucide-react';
import type { BoardView, TaskCard, Template } from '@/api/types';
import { api, qk } from '@/api';
import { navigate } from '@/app/router';
import { useFilterStore } from '@/app/store/filters';
import { cn } from '@/lib/cn';
import { Button, Menu, MenuCaret, Tooltip, type MenuProps } from '@/components/ui';
import { boardFilterCount, VIEW_ORDER } from './model';
import { useViewPrefsStore } from './flow/view-prefs';
import { FilterMenu } from './filter/FilterMenu';

/**
 * 3.4 工具栏：48px 高、左右 24px（沿用 `main` 的 padding），底边 1px。
 * 每段都不参与收缩，装不下时整行换行成两行——最小窗口 960px 下也不能互相压字。
 *
 * B15-③ 的取舍（Linear 式统一过滤）：
 * - 过滤入口只有一个「筛选」弹层（`filter/FilterMenu`），分组/需求/类型/优先级/Agent/
 *   标签六维在同一面板加规则；旧的 GroupSwitcher 与三枚 chip、「更多」下拉全部下线
 *   （「更多」和视图段本来就是同一参数的两种写法）；
 * - 已激活条件由结果区上方的 `filter/FilterChipsBar` 逐条可删地呈现；
 * - 没有「状态」chip（六列本身就是状态，再放一个多选会和列头互相矛盾）；
 * - 没有「看板／列表」切换（3.4 末段：列表是独立的「任务」页，不是看板的另一种显示）。
 *
 * 本文件另外导出 `CreateMenu`：3.8 任务列表页头部的那个下拉与这里是同一份规格，
 * 由 `features/task-list/create-menu.tsx` 直接复用（工具栏的视图段与筛选入口列表页不适用，
 * 所以复用只到下拉这一层）。
 */
export interface BoardToolbarProps {
  /** 打开快速新建；带 `template` 时用它预填（3.4 的模板下拉）。 */
  onCreate: (template?: Template) => void;
  /**
   * 2.md 8.1 全局依赖图入口 + B15 筛选值词表：当前看板拉平的任务集合
   * （由看板页传入）。传了才渲染「筛选」与三视图段；列表页复用本组件不传则不出现。
   */
  graphTasks?: readonly TaskCard[];
}

export function BoardToolbar({ onCreate, graphTasks }: BoardToolbarProps) {
  const view = useFilterStore((state) => state.view);
  const setView = useFilterStore((state) => state.setView);
  const reset = useFilterStore((state) => state.reset);
  const filters = useFilterStore();
  const conditions = useMemo(() => boardFilterCount(filters), [filters]);
  const count = conditions + (view === 'all' ? 0 : 1);
  const viewLabel = VIEW_ORDER.find((item) => item.view === view)?.label ?? '全部';

  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border">
      <ViewSegmented value={view} onChange={setView} />

      {graphTasks ? <FilterMenu cards={graphTasks} /> : null}

      <div className="flex shrink-0 items-center gap-2">
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

      {/* 窄窗口（最小 960px）下整行换行，靠这段把右侧动作推到行尾。 */}
      <span aria-hidden className="min-w-0 flex-1" />

      {/* 0919 4.11 + v0.0.4 W5 §6.4.1：看板/列表/流程图三视图切换。
          列表是独立路由（点击即跳转），看板/流程图是本页显示模式（记忆到用户偏好 prefs `board.view`）；
          旧的「列表视图」「依赖图」两个按钮由这一段取代（需求抽屉里的依赖图弹窗入口不动）。 */}
      {graphTasks ? <DisplaySegmented /> : null}

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
              'h-7 shrink-0 rounded-control border px-2.5 text-body transition-colors duration-140 ease-settle',
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

/* ---------------------------------------------------- 三视图切换（W5 §6.4.1） */

/**
 * 看板 / 列表 / 流程图：§6.4 布局图的段控件从依赖图弹窗升级为第三视图后，
 * 「当前视图」由 `useViewPrefsStore.mode`（看板内）+ 路由（列表为独立页）共同决定。
 * 活动态在列表页拿不到（列表页不挂本工具栏），段控件只在看板页出现，行为沿用 0919 4.11。
 */
function DisplaySegmented() {
  const mode = useViewPrefsStore((state) => state.mode);
  const setMode = useViewPrefsStore((state) => state.setMode);
  const items = [
    { id: 'board', label: '看板', icon: <Kanban className="size-3.5" aria-hidden /> },
    { id: 'list', label: '列表', icon: <List className="size-3.5" aria-hidden /> },
    { id: 'flow', label: '流程图', icon: <Network className="size-3.5" aria-hidden /> },
  ] as const;
  return (
    <div role="group" aria-label="视图切换" className="flex shrink-0 items-center gap-1" data-testid="display-segmented">
      {items.map((item) => {
        const active = item.id === mode;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            data-testid={`display-${item.id}`}
            onClick={() => {
              if (item.id === 'list') {
                navigate('tasks');
                return;
              }
              setMode(item.id);
            }}
            className={cn(
              'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body transition-colors duration-140 ease-settle',
              active
                ? 'border-border-strong bg-bg-surface text-primary'
                : 'border-transparent text-text-secondary hover:bg-bg-muted hover:text-text-primary',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
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
