import { useState } from 'react';
import { ChipGroup, type ChipGroupOption } from '@/components/ui';
import {
  SKILL_CATEGORY_TREE,
  UNCATEGORIZED_CATEGORY,
  UNCATEGORIZED_LABEL,
  leavesOfTopCategory,
} from './meta';
import type { SkillCategory, TopCategory } from './types';

/**
 * 技能库分类两级筛选栏（0925 树化 Q5-A 拍板形态：一级一行、点选展该级二级行）。
 *
 * 语义口径：
 * - 第一行 = 7 个一级 + 未分类；一级计数**含其子树全部叶子**（一级兼叶子的子树即自身）；
 * - 「选一级 = 该类全部叶子」的收拢语义：token 集里可并存一级/叶子/''，命中解释由
 *   meta 派生的 matchesCategoryTokens 在调用方展开——纯分组一级本身永不作为
 *   item.category 命中，命中靠子叶聚合（parentOfCategory）；
 * - 保留原多选 OR 语义：多选一级 = 各自子树叶子的并集；一级与其子叶混选时合理去重
 *   （选一级吸收已单选的子叶；在整体选中的一级下点某子叶，展开为「除它以外的全部子叶」，
 *   见 toggleLeafUnderTop）；一级的全部子叶被逐个选中时按选中态回显（收拢显示）；
 * - 计数为 0 的项置灰禁用但不消失、已选中项恒可点以取消（ChipGroup 现行为）；
 * - 可键盘操作：两行都是原生 button（aria-pressed），Tab/Enter 直达，无 hover 依赖。
 *
 * 分类是筛选栏唯一分类轴（历史拍板：不设「全部类型」下拉，type 只是执行形态）；
 * 筛选与搜索全在客户端做，不给 GET /skills 加 category= 查询参数（用户裁定）。
 */

/** 一级的「选中态」：自身 token 被选，或其全部子叶都被单选（收拢回显）。 */
export function isTopTokenActive(selected: readonly string[], top: TopCategory): boolean {
  const leaves = leavesOfTopCategory(top);
  return selected.includes(top) || leaves.every((leaf) => selected.includes(leaf));
}

/**
 * 切换一级 token（纯函数，便于单测）：
 * - 已选中（含子叶全覆盖）→ 一级 token 与其子叶单选 token 一并清掉；
 * - 未选中 → 收拢为一级 token 并吸收（移除）其子叶的单选 token——一级与子叶互斥存储，
 *   去重后语义仍是「该类全部叶子」。
 */
export function toggleTopToken(
  selected: readonly string[],
  top: TopCategory,
): string[] {
  const leaves: readonly string[] = leavesOfTopCategory(top);
  const base = selected.filter((token) => token !== top && !leaves.includes(token));
  return isTopTokenActive(selected, top) ? base : [...base, top];
}

/**
 * 在展开的纯分组一级（topEntry）下切换叶子 token（纯函数，便于单测）：
 * - 该一级整体选中时点某子叶 → 展开为「除它以外的全部子叶」（收拢语义的单点剔除）；
 * - 否则 → 该叶子单选 token 常规增删，与其他一级/叶子的 token 并存（多选 OR）。
 */
export function toggleLeafUnderTop(
  selected: readonly string[],
  top: TopCategory,
  leaf: SkillCategory,
): string[] {
  const children: readonly string[] = leavesOfTopCategory(top);
  if (selected.includes(top)) {
    return [
      ...selected.filter((token) => token !== top && !children.includes(token)),
      ...children.filter((child) => child !== leaf),
    ];
  }
  return selected.includes(leaf)
    ? selected.filter((token) => token !== leaf)
    : [...selected, leaf];
}

export interface SkillCategoryFilterProps {
  /** category 列取值 → 当前列表命中条数（key 含 ''=未分类）。 */
  counts: ReadonlyMap<string, number>;
  /** 已选 token 集（一级 / 叶子 / ''，多选 OR），由页面持有。 */
  selected: readonly string[];
  onChange: (next: string[]) => void;
}

export function SkillCategoryFilter({ counts, selected, onChange }: SkillCategoryFilterProps) {
  /** 当前展开二级行的纯分组一级（点选带子叶的一级时切换；收起条件见 expanded 推导）。 */
  const [openTop, setOpenTop] = useState<TopCategory | null>(null);

  const countOf = (value: string) => counts.get(value) ?? 0;

  const topOptions: ChipGroupOption[] = [
    ...SKILL_CATEGORY_TREE.map((top) => {
      const count = leavesOfTopCategory(top.value).reduce((sum, leaf) => sum + countOf(leaf), 0);
      return { value: top.value as string, label: top.value, count, disabled: count === 0 };
    }),
    {
      value: UNCATEGORIZED_CATEGORY,
      label: UNCATEGORIZED_LABEL,
      count: countOf(UNCATEGORIZED_CATEGORY),
      disabled: countOf(UNCATEGORIZED_CATEGORY) === 0,
    },
  ];

  // ChipGroup 以「数组含值 = 高亮」回显：全子叶单选的一级补一个合成 token（仅呈现用，
  // 不写回 selected——切换语义在 handleTopToggle 里按真实 token 集重算）。
  const row1Selected = [
    ...selected,
    ...SKILL_CATEGORY_TREE.map((top) => top.value).filter(
      (top) => !selected.includes(top) && isTopTokenActive(selected, top),
    ),
  ];

  const handleTopToggle = (next: string[]) => {
    const removed = row1Selected.find((value) => !next.includes(value));
    const added = next.find((value) => !row1Selected.includes(value));
    const token = added ?? removed;
    if (token === undefined) return;
    if (token === UNCATEGORIZED_CATEGORY) {
      onChange(
        selected.includes(token) ? selected.filter((t) => t !== token) : [...selected, token],
      );
      return;
    }
    const top = token as TopCategory;
    const entry = SKILL_CATEGORY_TREE.find((item) => item.value === top);
    const wasActive = row1Selected.includes(token);
    onChange(toggleTopToken(selected, top));
    if (!wasActive && entry && entry.children.length > 0) setOpenTop(top);
  };

  /** 二级行展开的纯分组一级：openTop 且其有子叶、且处于选中态（整一级 token 或有子叶单选）。 */
  const expanded = (() => {
    if (!openTop) return null;
    const entry = SKILL_CATEGORY_TREE.find((item) => item.value === openTop);
    if (!entry || entry.children.length === 0) return null;
    const covered =
      selected.includes(entry.value) || entry.children.some((leaf) => selected.includes(leaf));
    return covered ? entry : null;
  })();

  // 一级整体选中时其子叶在二级行全部回显为选中（它们已被「覆盖」，点击即展开语义）。
  const row2Selected = expanded
    ? selected.includes(expanded.value)
      ? [...selected, ...expanded.children]
      : selected
    : [];

  const handleLeafToggle = (next: string[]) => {
    if (!expanded) return;
    const removed = row2Selected.find((value) => !next.includes(value));
    const added = next.find((value) => !row2Selected.includes(value));
    const token = added ?? removed;
    if (token === undefined) return;
    onChange(toggleLeafUnderTop(selected, expanded.value, token as SkillCategory));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <ChipGroup
        label="分类"
        aria-label="分类一级筛选"
        options={topOptions}
        selected={row1Selected}
        onChange={handleTopToggle}
      />
      {expanded ? (
        <ChipGroup
          label={`${expanded.value} · 二级`}
          aria-label={`${expanded.value}二级筛选`}
          options={expanded.children.map((leaf) => ({
            value: leaf,
            label: leaf,
            count: countOf(leaf),
            disabled: countOf(leaf) === 0,
          }))}
          selected={row2Selected}
          onChange={handleLeafToggle}
        />
      ) : null}
    </div>
  );
}
