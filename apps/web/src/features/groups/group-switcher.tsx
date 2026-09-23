import { Check, FolderPlus, Settings2 } from 'lucide-react';
import { navigate } from '@/app/router';
import { Menu, MenuCaret, type MenuProps } from '@/components/ui';
import { cn } from '@/lib/cn';
import { DEFAULT_GROUPING_PREFS, useGroupingStore } from '@/features/board/grouping/useGroupingState';
import { useActiveGroups, useGroups } from './queries';
import { GroupGlyph } from './group-glyph';

/**
 * 7.8 / 4.5 分组切换器：`分组: [全部分组 ▾]`，多选。
 *
 * 状态真值是分组 store 的 `groupIds`（空数组 = 全部分组），选中 >1 时联动把主分组
 * 切成「分组」（原型 4.5「选中多个分组时，看板自动按分组泳道」）——联动走 store 的
 * `update`，让偏好持久化（localStorage）在同一个入口落盘。归档分组不出现在候选里（5.1）。
 *
 * Menu 是单选语义的控件（selectedId 画一个对勾），多选在这里用「对勾图标」表达勾选态，
 * 与 7.8 的 ☑ 原型对齐；MenuCaret/触发按钮样式沿用工具栏 chip 的规格。
 */
export function GroupSwitcher() {
  const groups = useActiveGroups();
  const groupIds = useGroupingStore((state) => state.groupIds);
  const update = useGroupingStore((state) => state.update);

  const items = groups.data?.items ?? [];
  const allSelected = groupIds.length === 0;

  const setSelection = (next: string[]) => {
    // 「全部分组」＝回到默认六列：清空 groupIds 之外还要把主分组复位到「状态」、清掉泳道筛选，
    // 否则从分组页「查看任务」强制进来的泳道态（primary:'group' + 隐藏的 laneFilter）会卡住，
    // 用户点「全部分组」后仍停在泳道视图——即「回不到全量」。走既有 update 持久化通道复位。
    if (next.length === 0) {
      update({ groupIds: [], primary: DEFAULT_GROUPING_PREFS.primary, laneFilter: [] });
      return;
    }
    // 4.5：选中 >1 分组自动按分组为主分组；回到 ≤1 时不改用户的原选择。
    update({ groupIds: next, ...(next.length > 1 ? { primary: 'group' } : {}) });
  };

  const toggle = (id: string) => {
    setSelection(
      groupIds.includes(id) ? groupIds.filter((value) => value !== id) : [...groupIds, id],
    );
  };

  const menuGroups: MenuProps['groups'] = [
    {
      items: [
        {
          id: 'all',
          label: '全部分组',
          icon: allSelected ? <Check className="size-3.5 text-primary" aria-hidden /> : undefined,
          onSelect: () => setSelection([]),
        },
      ],
    },
    {
      label: '选择分组',
      items:
        items.length === 0
          ? [{ id: 'no-group', label: '还没有分组', disabled: true }]
          : items.map((group) => {
              const checked = groupIds.includes(group.id);
              return {
                id: group.id,
                label: (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <GroupGlyph group={group} />
                    <span className="truncate">{group.name}</span>
                  </span>
                ),
                icon: checked ? <Check className="size-3.5 text-primary" aria-hidden /> : undefined,
                onSelect: () => toggle(group.id),
              };
            }),
    },
    {
      items: [
        {
          id: 'create',
          label: '新建分组',
          icon: <FolderPlus className="size-3.5" aria-hidden />,
          onSelect: () => navigate('groups'),
        },
        {
          id: 'manage',
          label: '管理分组',
          icon: <Settings2 className="size-3.5" aria-hidden />,
          onSelect: () => navigate('groups'),
        },
      ],
    },
  ];

  // 名字兜底查全量（含归档）：作用域里的分组刚被归档时，标签也要报得出名字。
  const all = useGroups();
  const label = allSelected
    ? '全部分组'
    : groupIds.length === 1
      ? ((items.find((group) => group.id === groupIds[0]) ??
          all.data?.items.find((group) => group.id === groupIds[0]))?.name ?? '1 个分组')
      : `${groupIds.length} 个分组`;

  return (
    <Menu
      width={240}
      groups={menuGroups}
      trigger={({ open, toggle: onToggle }) => (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label="选择分组"
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body transition-colors duration-120 ease-out',
            allSelected
              ? 'border-border text-text-secondary hover:bg-bg-muted hover:text-text-primary'
              : 'border-primary bg-primary-light text-primary',
          )}
        >
          分组: {label}
          <MenuCaret open={open} />
        </button>
      )}
    />
  );
}
