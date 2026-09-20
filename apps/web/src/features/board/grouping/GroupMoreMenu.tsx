import type { ReactNode } from 'react';
import { Menu } from '@/components/ui';
import type { GroupDimensionKey } from './dimensions';
import { useGroupingStore } from './useGroupingState';

const SORT_OPTIONS: readonly ['manual' | 'priority' | 'updated_at', string][] = [
  ['manual', '手动'],
  ['priority', '优先级'],
  ['updated_at', '最近更新'],
];

/**
 * 4.10 分组更多菜单（泳道头 ⋯）：重命名 / 折叠 / 只看 / 隐藏 + 组内排序 + 导出 / 归档。
 * 与后端相关的两项（导出、归档）只回调不实现——接线时由 board 页补真实动作。
 */
export interface GroupMoreMenuProps {
  laneKey: string;
  laneLabel: string;
  dimension: GroupDimensionKey;
  collapsed: boolean;
  /** 只读快照，供菜单项渲染判断。 */
  laneKeys: readonly string[];
  onRename?: () => void;
  /** 接缝：7.6「导出该分组」。 */
  onExport?: () => void;
  /** 接缝：7.6「归档该分组已完成任务」。 */
  onArchiveDone?: () => void;
  /**
   * v0.0.4 W4 §5.6：泳道头「归档分组」（仅分组维度）。缺省不渲染该项；
   * `disabled` + `hint`（还剩 N 个）表达置灰口径，服务端 409 兜底。
   */
  archiveGroup?: {
    onSelect: () => void;
    disabled?: boolean;
    hint?: string;
  };
}

export function GroupMoreMenu({
  laneKey,
  laneLabel,
  dimension,
  collapsed,
  laneKeys,
  onRename,
  onExport,
  onArchiveDone,
  archiveGroup,
}: GroupMoreMenuProps): ReactNode {
  const toggleLaneCollapsed = useGroupingStore((state) => state.toggleLaneCollapsed);
  const setLaneFilter = useGroupingStore((state) => state.setLaneFilter);
  const laneFilter = useGroupingStore((state) => state.laneFilter);
  const laneSort = useGroupingStore((state) => state.laneSort);
  const update = useGroupingStore((state) => state.update);

  return (
    <Menu
      align="end"
      width={200}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="rounded px-1.5 py-0.5 text-text-tertiary hover:bg-bg-raised hover:text-text-secondary"
          aria-label={`分组「${laneLabel}」更多操作`}
        >
          ⋯
        </button>
      )}
      groups={[
        {
          items: [
            { id: 'rename', label: '重命名分组', onSelect: onRename, disabled: !onRename },
            {
              id: 'collapse',
              label: collapsed ? '展开该分组' : '折叠该分组',
              onSelect: () => toggleLaneCollapsed(dimension, laneKey, !collapsed),
            },
            {
              id: 'only',
              label: '只看该分组',
              onSelect: () => setLaneFilter([laneKey]),
            },
            {
              id: 'hide',
              label: '隐藏该分组',
              // 隐藏 = 在当前筛选基础上排除本泳道；没有筛选能力差异，等价于从全集中剔除。
              onSelect: () => {
                const rest = laneFilter.length > 0 ? laneFilter.filter((key) => key !== laneKey) : laneKeys.filter((key) => key !== laneKey);
                setLaneFilter(rest);
              },
            },
          ],
        },
        {
          label: '排序',
          items: SORT_OPTIONS.map(([value, label]) => ({
            id: `sort:${value}`,
            label,
            onSelect: () => update({ laneSort: value }),
          })),
        },
        {
          items: [
            { id: 'export', label: '导出该分组', onSelect: onExport, disabled: !onExport },
            {
              id: 'archive',
              label: '归档该分组已完成任务',
              onSelect: onArchiveDone,
              disabled: !onArchiveDone,
            },
            // v0.0.4 W4 §5.6「泳道头更多操作 → 归档分组」：整组归档入口只在分组维度、
            // 且调用方给了回调时出现；未完成数 >0 置灰并提示剩余（服务端另有 409 兜底）。
            ...(archiveGroup
              ? [
                  {
                    id: 'archive-group',
                    label: '归档分组',
                    hint: archiveGroup.hint,
                    onSelect: archiveGroup.onSelect,
                    disabled: archiveGroup.disabled,
                  },
                ]
              : []),
          ],
        },
      ]}
      selectedId={laneSort === 'manual' ? undefined : `sort:${laneSort}`}
    />
  );
}
