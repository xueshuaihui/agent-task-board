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

/**
 * C-6b② 行内名称的窗口化字符预算（含省略号位）。按最窄挂载——320px 子技能弹层
 * 查询态实测取数：行左右 pad 16 + 勾选/check 槽 + 版本 ~48 + 类型徽标 ~52 + 间隙
 * ~24，留给名称约 ~180px ≈ 24 个拉丁字符；超出预算交给 windowAroundHits 按命中
 * 位置开窗，不再依赖 CSS truncate 随机吞词。
 */
export const PICKER_NAME_BUDGET = 24;

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
  /** name 字段高亮分段（落在 label 上；传了 nameBudget 时落在窗口化片段上）。 */
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

/** C-6b② 窗口里标记「原文有片段被省略」的占位符（两侧与命中段之间的间隙都用它）。 */
export const WINDOW_ELLIPSIS = '…';

/** windowAroundHits 的输出：开窗后的展示文 + 落在其上的命中区间。 */
export interface HitWindow {
  /** 预算内时 = 原文；否则为片段拼接，被省略的头/尾/间隙以 … 标记。 */
  text: string;
  /** text 上的命中区间（升序不重叠），可直接喂 highlightSegments。 */
  ranges: Array<[number, number]>;
  /** 是否发生了截断（false = 原文完整保留）。 */
  truncated: boolean;
}

/**
 * C-6b②「命中窗口化」：名称过长必须截断时，以命中位置为中心开窗——每段命中
 * 前后留等量语境（预算均分），间隙与两侧以 … 标记，保证全部命中段一定落在可视
 * 片段内。此前 320px 弹层里纯 CSS truncate 把 `<mark>` 整段吞在省略号后面
 * （搜 `18steps` 命中 `financial-analysis-18steps` 高亮等于没显示），根因是
 * 截断发生在渲染层、命中位置对截断不可见——窗口化必须在纯数据层做。
 *
 * 长度不变式：输出 text.length ≤ budget（省略号也计预算）。
 * - 无命中：退化为前缀截断（与原 truncate 观感一致）；
 * - 命中总长 + 间隙省略号已超预算：从首个命中起点硬开窗，保底第一段命中可见。
 */
export function windowAroundHits(
  text: string,
  ranges: ReadonlyArray<[number, number]>,
  budget: number,
): HitWindow {
  const cap = Math.max(1, Math.floor(budget));
  const safe = projectRanges(ranges, 0, text.length);
  if (text.length <= cap) return { text, ranges: safe, truncated: false };
  if (safe.length === 0) {
    if (cap === 1) return { text: WINDOW_ELLIPSIS, ranges: [], truncated: true };
    return { text: text.slice(0, cap - 1) + WINDOW_ELLIPSIS, ranges: [], truncated: true };
  }

  const hitLength = safe.reduce((sum, [start, end]) => sum + (end - start), 0);
  const gaps = safe.length + 1; // 首段前 + 段间 + 末段后，间隙最坏各占一个省略号。
  if (hitLength + gaps > cap) {
    // 命中本身就放不下预算：放弃语境，从首个命中起点取尽量长的连续片段（保底第一段可见）。
    const start = safe[0][0];
    const prefix = start > 0 ? WINDOW_ELLIPSIS : '';
    const maxBody = Math.max(0, cap - prefix.length);
    if (maxBody === 0) return { text: WINDOW_ELLIPSIS, ranges: [], truncated: true };
    const needSuffix = start + maxBody < text.length;
    const body = text.slice(start, start + Math.max(0, maxBody - (needSuffix ? 1 : 0)));
    const outRanges = projectRanges(safe, start, start + body.length).map(
      ([s, e]) => [s + prefix.length, e + prefix.length] as [number, number],
    );
    return {
      text: prefix + body + (needSuffix ? WINDOW_ELLIPSIS : ''),
      ranges: outRanges,
      truncated: true,
    };
  }

  // 语境预算：先为每个间隙预留省略号位，剩余预算在 gaps 个间隙位上均分。
  const context = Math.floor((cap - hitLength - gaps) / gaps);
  const spans: Array<[number, number]> = [];
  for (const [start, end] of safe) {
    const from = Math.max(0, start - context);
    const prev = spans[spans.length - 1];
    if (prev && from <= prev[1]) prev[1] = Math.max(prev[1], end);
    else spans.push([from, end]);
  }
  const last = spans[spans.length - 1];
  last[1] = Math.min(text.length, last[1] + context);

  let out = '';
  const outRanges: Array<[number, number]> = [];
  let previousEnd = 0;
  let spanIndex = 0;
  for (const [start, end] of spans) {
    const ellipsis = spanIndex === 0 ? start > 0 : start > previousEnd;
    if (ellipsis) out += WINDOW_ELLIPSIS;
    spanIndex += 1;
    const offset = out.length - start;
    for (const [hitStart, hitEnd] of safe) {
      if (hitStart >= start && hitEnd <= end) outRanges.push([hitStart + offset, hitEnd + offset]);
    }
    out += text.slice(start, end);
    previousEnd = end;
  }
  if (previousEnd < text.length) out += WINDOW_ELLIPSIS;
  return { text: out, ranges: outRanges, truncated: true };
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

/** pickerRowPlan 的可选展示参数（全部省略 = 与 C-6b 之前的行为逐字节一致）。 */
export interface PickerRowPlanOptions {
  /** 名称窗口化字符预算（C-6b②）：给定时才截断/开窗，省略 = 全名直出。 */
  nameBudget?: number;
}

/** 名称高亮分段：给了 nameBudget 先按命中位置开窗、再在窗口文本上出分段。 */
function nameSegmentsFor(
  matches: readonly SkillFieldMatch[],
  name: string,
  options: PickerRowPlanOptions,
): HighlightSegment[] {
  const match = matches.find((entry) => entry.field === 'name');
  const ranges = match?.ranges ?? [];
  if (options.nameBudget === undefined) return highlightSegments(name, ranges);
  const window = windowAroundHits(name, ranges, options.nameBudget);
  return highlightSegments(window.text, window.ranges);
}

/** 单条命中 → 行计划。duplicateNames 判消歧；matches 供高亮投影。 */
export function pickerRowPlan(
  hit: SkillSearchHit,
  duplicateNames: ReadonlySet<string>,
  options: PickerRowPlanOptions = {},
): PickerRowPlan {
  const { skill, matches } = hit;
  const duplicate = duplicateNames.has(skill.name);
  const typeLabel = SKILL_TYPE_META[skill.type].label;
  // type 的 D-1 待匹配文本是 `${type} ${label}`；展示只取中文标签那一段。
  const typeWindow = `${skill.type} `.length;
  return {
    skill,
    label: skill.name,
    suffix: duplicate ? ` ·${skill.id.slice(-6)}` : '',
    nameSegments: nameSegmentsFor(matches, skill.name, options),
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
  options: PickerRowPlanOptions = {},
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
      rows: skills.map((skill) =>
        pickerRowPlan({ skill, score: 0, matches: [] }, duplicateNames, options),
      ),
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
  options: PickerRowPlanOptions = {},
): PickerFlatPlan {
  const capped = Math.max(1, Math.floor(limit));
  return {
    rows: hits.slice(0, capped).map((hit) => pickerRowPlan(hit, duplicateNames, options)),
    total: hits.length,
    truncated: hits.length > capped,
  };
}
