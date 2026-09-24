import type { Skill } from './types';
import { SKILL_TYPE_META, UNCATEGORIZED_LABEL } from './meta';
import type { SkillFieldMatch, SkillSearchField, SkillSearchHit } from './skill-search';

/**
 * D-2 SkillPicker 的纯逻辑层（零 React、零 DOM）：三处「选技能」（任务详情绑定、
 * 拆解草案多选、子技能引用）统一成一套行为标准，本文件承载其中不依赖渲染的部分——
 * 空查询分组计划、查询态平铺计划、重名消歧、D-1 matches 的高亮切片。
 *
 * 匹配口径完全建立在 D-1（skill-search.ts）之上：候选顺序 = searchSkills 的
 * score 降序全序，高亮区间 = SkillFieldMatch.ranges；这里只做「展示投影」，
 * 不另写第二套匹配。分组排序沿用 SubskillField 既有观感（组大者先、同组按名、
 * 未分类恒最后、组内名称稳定序），不发明第二套。
 */

/** 展示上限默认值：三处现状取向是「截断优于全量铺满」（8 条硬编码不进组件）。 */
export const DEFAULT_PICKER_LIMIT = 20;

/** 文本分段：hit 段渲染高亮，非 hit 段原样。拼接恒等于展示文本。 */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/** 一行的渲染计划：消歧名 + 各展示字段的高亮分段。 */
export interface PickerRowPlan {
  skill: Skill;
  /** 名称展示文（不含消歧后缀）。 */
  label: string;
  /** 消歧后缀（` ·id后6位`），非重名时为空串。 */
  suffix: string;
  /** name 字段高亮分段（落在 label 上）。 */
  nameSegments: HighlightSegment[];
  /** 分类展示文（含未分类文案）上的高亮分段。 */
  categorySegments: HighlightSegment[];
  /** 类型中文标签上的高亮分段。 */
  typeSegments: HighlightSegment[];
}

/** 空查询的一个分组：组头 `分类（条数）`，未分类恒排最后。 */
export interface PickerGroupPlan {
  /** 分组键：skill.category 原值（'' = 未分类）。 */
  key: string;
  /** 组头文案，如「开发编程（5）」「未分类（3）」。 */
  title: string;
  rows: PickerRowPlan[];
}

/** 查询态平铺计划：score 序 + 截断。 */
export interface PickerFlatPlan {
  rows: PickerRowPlan[];
  /** 命中总数（可多于 rows.length），组头弱提示用。 */
  total: number;
  /** 是否被 limit 截断（渲染侧据此出「结果过多，请细化查询」尾提示）。 */
  truncated: boolean;
}

/** 出现不止一次的技能名集合——消歧后缀的判据。口径与 breakdown 条款 81 一致：
 * 基于调用方给的全量作用域统计，而不是过滤后的可见列表。 */
export function duplicateNameSet(skills: readonly Pick<Skill, 'name'>[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) dup.add(skill.name);
    else seen.add(skill.name);
  }
  return dup;
}

/** 分类展示文：'' 走「未分类」文案（与 D-1 fieldTexts 的 category 口径逐字一致）。 */
export function categoryDisplay(skill: Skill): string {
  return skill.category === '' ? UNCATEGORIZED_LABEL : skill.category;
}

/** 把 [start,end) 区间投影到展示窗口 [windowStart,windowEnd)：裁剪越界、平移归零、
 * 空区间丢弃，输出保持升序不重叠。D-1 的 id（`id + 后6位`）与 type（`workflow 工作流`）
 * 是拼接串，展示时只截窗口片段——落在窗口外的区间在这里被安全剔除。 */
export function projectRanges(
  ranges: ReadonlyArray<[number, number]>,
  windowStart: number,
  windowEnd: number,
): Array<[number, number]> {
  const clipped: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const next: [number, number] = [Math.max(start, windowStart), Math.min(end, windowEnd)];
    if (next[1] > next[0]) clipped.push([next[0] - windowStart, next[1] - windowStart]);
  }
  return mergeRanges(clipped);
}

/** 区间合并（重叠或首尾相接视为一段），输出升序不重叠。 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      if (range[1] > last[1]) last[1] = range[1];
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

/** 展示文本 + 命中区间 → 交替分段。越界区间裁剪兜底；拼接结果恒等于原文。 */
export function highlightSegments(
  display: string,
  ranges: ReadonlyArray<[number, number]>,
): HighlightSegment[] {
  const safe = projectRanges(ranges, 0, display.length);
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of safe) {
    if (start > cursor) segments.push({ text: display.slice(cursor, start), hit: false });
    segments.push({ text: display.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < display.length) segments.push({ text: display.slice(cursor), hit: false });
  return segments;
}

/**
 * 取某字段在展示文本上的高亮分段。展示文本按 D-1 口径必然是对应 fieldText 的
 * 片段（name/category 全等；type 展示中文标签、取拼接串中其出现位置起的窗口），
 * 定位不到（如 -1）时整段无高亮，绝不把拼接串原样铺到 UI 上。
 */
function segmentsForField(
  matches: readonly SkillFieldMatch[],
  field: SkillSearchField,
  display: string,
  windowStart: number,
): HighlightSegment[] {
  const match = matches.find((entry) => entry.field === field);
  if (!match) return highlightSegments(display, []);
  return highlightSegments(display, projectRanges(match.ranges, windowStart, windowStart + display.length));
}

/** 单条命中 → 行计划。duplicateNames 判消歧；matches 供高亮投影。 */
export function pickerRowPlan(hit: SkillSearchHit, duplicateNames: ReadonlySet<string>): PickerRowPlan {
  const { skill, matches } = hit;
  const duplicate = duplicateNames.has(skill.name);
  const typeLabel = SKILL_TYPE_META[skill.type].label;
  // type 的 D-1 待匹配文本是 `${type} ${label}`；展示只取中文标签那一段。
  const typeWindow = `${skill.type} `.length;
  return {
    skill,
    label: skill.name,
    suffix: duplicate ? ` ·${skill.id.slice(-6)}` : '',
    nameSegments: segmentsForField(matches, 'name', skill.name, 0),
    categorySegments: segmentsForField(matches, 'category', categoryDisplay(skill), 0),
    typeSegments: segmentsForField(matches, 'type', typeLabel, typeWindow),
  };
}

/** 组内行序：名称 localeCompare 稳定序、同名按 id 全序（与 D-1 并列序同思路）。 */
function byNameThenId(a: Skill, b: Skill): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * 空查询的分组计划（直接吃候选列表即可——searchSkills 空查询按原样返回全量、
 * matches 为空，这里不重复调用）。组序 = 组大者先、同规模按组名 localeCompare，
 * 「未分类」恒最后（与 SubskillField 现行排序逐条对齐）。
 */
export function buildGroupPlan(
  candidates: readonly Skill[],
  duplicateNames: ReadonlySet<string>,
): PickerGroupPlan[] {
  const byCategory = new Map<string, Skill[]>();
  for (const skill of candidates) {
    const label = categoryDisplay(skill);
    const bucket = byCategory.get(label);
    if (bucket) bucket.push(skill);
    else byCategory.set(label, [skill]);
  }
  const groups: PickerGroupPlan[] = [];
  for (const [label, skills] of byCategory) {
    skills.sort(byNameThenId);
    groups.push({
      key: label === UNCATEGORIZED_LABEL ? '' : label,
      title: `${label}（${skills.length}）`,
      rows: skills.map((skill) => pickerRowPlan({ skill, score: 0, matches: [] }, duplicateNames)),
    });
  }
  groups.sort((a, b) => {
    if (a.key === '') return 1;
    if (b.key === '') return -1;
    return b.rows.length - a.rows.length || a.title.localeCompare(b.title);
  });
  return groups;
}

/**
 * 查询态平铺计划：hits 已是 searchSkills 的 score 降序全序，这里只截断 + 计数，
 * 不再排序、不再分组（命中序即意义序）。
 */
export function buildFlatPlan(
  hits: readonly SkillSearchHit[],
  duplicateNames: ReadonlySet<string>,
  limit: number = DEFAULT_PICKER_LIMIT,
): PickerFlatPlan {
  const capped = Math.max(1, Math.floor(limit));
  return {
    rows: hits.slice(0, capped).map((hit) => pickerRowPlan(hit, duplicateNames)),
    total: hits.length,
    truncated: hits.length > capped,
  };
}
