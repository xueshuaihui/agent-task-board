import type { TaskCard } from '@/api/types';
import { priorityText } from '@/lib/labels';
import { useFilterStore, type FilterState } from '@/app/store/filters';

/**
 * B15-③：看板筛选弹层/chip 条共用的维度词表与派生逻辑。
 *
 * 值候选从**当前看板快照**派生（分组/需求/Agent 没有独立的服务端词表接口）：
 * 过滤生效时候选会随可见卡收缩，这是可接受的取舍——chip 条保证已选值永远可见可删；
 * 已选但不在候选里的值会被补回选项（回显不失明）。
 */

export type FilterDimKey = 'groups' | 'requirements' | 'type' | 'priority' | 'agents' | 'tags';

/** 弹层内的展示顺序。 */
export const FILTER_DIMENSIONS: readonly { key: FilterDimKey; label: string }[] = [
  { key: 'groups', label: '分组' },
  { key: 'requirements', label: '需求' },
  { key: 'type', label: '类型' },
  { key: 'priority', label: '优先级' },
  { key: 'agents', label: 'Agent' },
  { key: 'tags', label: '标签' },
];

/** 服务端约定：`none` = 该维「未设置」（group_id/parent/agent 为 NULL）。 */
export const NONE_VALUE = 'none';

export interface FilterOption {
  value: string;
  label: string;
}

const NONE_LABEL: Partial<Record<FilterDimKey, string>> = {
  groups: '无分组',
  requirements: '未归属需求',
  agents: '未设置',
};

function uniqStrings(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];
}

export type FilterOptionsMap = Record<FilterDimKey, FilterOption[]>;

export interface DeriveInput {
  cards: readonly TaskCard[];
  /** 未归档分组（id→name）。 */
  groups: readonly { id: string; name: string; color?: string | null }[];
  /** settings `task_types`。 */
  types: readonly string[];
  /** /tags 词表。 */
  tags: readonly string[];
}

export function deriveFilterOptions({ cards, groups, types, tags }: DeriveInput): FilterOptionsMap {
  const requirementValues = uniqStrings(cards.map((card) => card.parent?.id));
  const requirementLabels = new Map(
    requirementValues.map((id) => [id, cards.find((c) => c.parent?.id === id)?.parent?.title ?? id]),
  );

  const agentValues = uniqStrings(cards.map((card) => card.agent_name));
  const typeValues = [...new Set(uniqStrings([...types, ...cards.map((card) => card.type)]))];
  const tagValues = [...new Set(uniqStrings([...tags, ...cards.flatMap((card) => card.tags)]))];

  const listNone = (key: FilterDimKey, values: readonly string[], labelOf: (v: string) => string): FilterOption[] => {
    const options = values.map((value) => ({ value, label: labelOf(value) }));
    const noneLabel = NONE_LABEL[key];
    if (noneLabel && !options.some((option) => option.value === NONE_VALUE)) {
      options.push({ value: NONE_VALUE, label: noneLabel });
    }
    return options;
  };

  return {
    groups: listNone(
      'groups',
      groups.map((group) => group.id),
      (id) => groups.find((group) => group.id === id)?.name ?? id,
    ),
    requirements: listNone('requirements', requirementValues, (id) => requirementLabels.get(id) ?? id),
    type: typeValues.map((value) => ({ value, label: value })),
    priority: [0, 1, 2, 3].map((value) => ({ value: String(value), label: priorityText(value) })),
    agents: listNone('agents', agentValues, (value) => value),
    tags: tagValues.map((value) => ({ value, label: value })),
  };
}

/** 已选值 → 字符串数组（priority 存的是 number）。 */
export function selectedValues(state: Pick<FilterState, FilterDimKey>, dim: FilterDimKey): string[] {
  if (dim === 'priority') return state.priority.map(String);
  return [...state[dim]];
}

/** ChipGroup 的整维回写；不新增 store action 是因为这里永远是「整组替换」语义。 */
export function setFilterDimension(dim: FilterDimKey, values: string[]): void {
  if (dim === 'priority') {
    useFilterStore.setState({
      priority: values.map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 3),
    });
    return;
  }
  useFilterStore.setState({ [dim]: values } as unknown as Pick<FilterState, FilterDimKey>);
}

/** chip 条/弹层共用的显示名查表；查不到回显裸值（旧分组被删等场景）。 */
export function optionLabel(options: readonly FilterOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
