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
 * C-6b② 行内名称的窗口化显示宽度预算上限（C-6c②：单位从「字符数」改为「显示宽度」——
 * 拉丁/半角 1 单位、CJK/全角约 2 单位，实测本字体 latin ≈ 8px/单位、CJK ≈ 13.5px/字）。
 * 纯字符数预算对 CJK 名严重低估宽度：320px 弹层里 20 字 CJK 名「20 ≤ 24」原样吐出，
 * 命中高亮整段被 CSS ellipsis 吞在盒外（走查实测 mark right 381 vs 名称盒 right 208）。
 * 这里只作上限：真实预算由 nameBudgetFromBoxPx 按该行名称盒的实测像素宽换算。
 */
export const PICKER_NAME_BUDGET = 24;

/** 显示宽度 1 单位对应的像素宽（走查实测 latin ≈ 8px/单位，CJK ≈ 13.5px ≈ 1.7 单位，取 8 偏保守）。 */
export const PICKER_NAME_PX_PER_UNIT = 8;

/** 预算下限：盒宽再窄也至少给出 8 单位（≈4 个 CJK 字），病态布局下窗口仍保有意义。 */
export const PICKER_NAME_MIN_BUDGET = 8;

/** 单 UTF-16 码元的显示宽度：拉丁/数字/常用变音符等（< U+2000）与半角假名为 1；
 * CJK、全角标点、省略号 … 等其余为 2。非 BMP 字符占 2 个码元、合计 4，偏保守
 * （宁可早一个省略号，也不让命中高亮溢出盒子被 CSS 吞掉）。 */
function codeUnitWidth(code: number): number {
  if (code < 0x2000) return 1;
  if (code >= 0xff61 && code <= 0xff9f) return 1;
  return 2;
}

/** 字符串的显示宽度预算（与 PICKER_NAME_BUDGET 同单位）。按 UTF-16 码元计，与
 * D-1 命中区间的索引口径（slice 坐标）保持一致。 */
export function displayWidth(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) total += codeUnitWidth(text.charCodeAt(i));
  return total;
}

/**
 * C-6c② 名称盒实测像素宽 → 窗口预算（显示宽度单位）：
 * `budget = clamp(floor(boxPx / PX_PER_UNIT), MIN, PICKER_NAME_BUDGET)`。
 * 逐行测是对的：同一面板里每行的兄弟徽标/版本/消歧后缀占宽不同，名称盒宽也不同。
 * 消歧后缀不在此扣减——它由布局预留（suffix 是 truncate 盒之外的 shrink-0 兄弟，
 * 测得盒宽天然不含它，见 skill-picker.tsx 的 PickerRow）。
 */
export function nameBudgetFromBoxPx(boxPx: number): number {
  const units = Math.floor(boxPx / PICKER_NAME_PX_PER_UNIT);
  return Math.min(PICKER_NAME_BUDGET, Math.max(PICKER_NAME_MIN_BUDGET, units));
}

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
  /** 消歧后缀（ ` ·id后6位`），非重名时为空串。渲染为 truncate 盒外的 shrink-0 兄弟，恒可见（C-6c③）。 */
  suffix: string;
  /** name 字段命中区间（label 全名坐标系，升序不重叠）。渲染层按行实测盒宽窗口化（C-6c②）。 */
  nameRanges: Array<[number, number]>;
  /** 全名 + 高亮分段（未窗口化）：首帧未测到盒宽时的退化形态，见 pickerRowNameSegments。 */
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

/** 分类展示文：'' 走「未分类」文案，词表值直出叶子本身（徽标/分组只用叶子，
 * 一级归属是筛选栏与搜索命中面的事，见 skill-search 的 categoryFieldText 拼接）。 */
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

/** C-6b② 窗口里标记「原文有片段被省略」的占位符（两侧与命中段之间的间隙都用它）。
 * C-6c②：它按显示宽度计入预算（本字体下渲染为全角宽，取 2 单位，偏保守）。 */
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
 * C-6c②：budget 的单位是**显示宽度**（displayWidth，拉丁 1 / CJK 2），不是字符数。
 * 走查实测：CJK 名按字符数计预算会严重低估像素宽，20 字 CJK 名在 24「字符」预算下
 * 原样吐出、命中落在名称盒可视区之外——单位必须与盒宽同源（nameBudgetFromBoxPx）。
 *
 * 长度不变式：输出 displayWidth(text) ≤ max(budget, displayWidth(省略号))——
 * 预算病态小（≤ 一个省略号）时至少吐一枚省略号标记截断，这是唯一允许越界的情形。
 * - 无命中：退化为前缀截断（供直接调用方兜底；选择器渲染层已改为无命中恒全名，见 pickerRowNameSegments）；
 * - 命中总宽 + 间隙省略号已超预算：从首个命中起点硬开窗，保底第一段命中可见。
 */
export function windowAroundHits(
  text: string,
  ranges: ReadonlyArray<[number, number]>,
  budget: number,
): HitWindow {
  const cap = Math.max(1, Math.floor(budget));
  const safe = projectRanges(ranges, 0, text.length);
  if (displayWidth(text) <= cap) return { text, ranges: safe, truncated: false };

  const ell = displayWidth(WINDOW_ELLIPSIS);
  // 逐码元累计显示宽度：slice 区间 [a,b) 的宽度 = cum[b] - cum[a]。
  const cum: number[] = [0];
  for (let i = 0; i < text.length; i += 1) cum.push(cum[i] + codeUnitWidth(text.charCodeAt(i)));
  /** 从 from 向右取宽度 ≤ units 的最大码元数，返回右开边界。 */
  const fitRight = (from: number, units: number): number => {
    let end = from;
    while (end < text.length && cum[end + 1] - cum[from] <= units) end += 1;
    return end;
  };
  /** 从 to 向左取宽度 ≤ units 的最大码元数，返回左边界。 */
  const fitLeft = (to: number, units: number): number => {
    let start = to;
    while (start > 0 && cum[to] - cum[start - 1] <= units) start -= 1;
    return start;
  };

  if (safe.length === 0) {
    if (cap <= ell) return { text: WINDOW_ELLIPSIS, ranges: [], truncated: true };
    const end = fitRight(0, cap - ell);
    return { text: text.slice(0, end) + WINDOW_ELLIPSIS, ranges: [], truncated: true };
  }

  const hitWidth = safe.reduce((sum, [start, end]) => sum + (cum[end] - cum[start]), 0);
  const gaps = safe.length + 1; // 首段前 + 段间 + 末段后，间隙最坏各占一个省略号。
  if (hitWidth + gaps * ell > cap) {
    // 命中本身就放不下预算：放弃语境，从首个命中起点按宽度取尽量长的连续片段（保底第一段可见）。
    const start = safe[0][0];
    const prefix = start > 0 ? WINDOW_ELLIPSIS : '';
    const maxBody = cap - (start > 0 ? ell : 0);
    if (maxBody <= 0) return { text: WINDOW_ELLIPSIS, ranges: [], truncated: true };
    const reachable = fitRight(start, maxBody);
    // 尾部省略号只有在必将吞掉真实内容、且扣完后窗口仍非空时才挂（否则窗口宽度超预算）。
    const needSuffix = reachable < text.length && fitRight(start, maxBody - ell) > start;
    const bodyEnd = needSuffix ? fitRight(start, maxBody - ell) : reachable;
    const body = text.slice(start, bodyEnd);
    // projectRanges 已把区间平移到以窗口起点为零点，这里只需再加上前导省略号的宽度位。
    const outRanges = projectRanges(safe, start, bodyEnd).map(
      ([s, e]) => [s + prefix.length, e + prefix.length] as [number, number],
    );
    return {
      text: prefix + body + (needSuffix ? WINDOW_ELLIPSIS : ''),
      ranges: outRanges,
      truncated: true,
    };
  }

  // 语境预算：先为每个间隙预留省略号位（各 ell 单位），剩余预算在 gaps 个间隙位上均分。
  const context = Math.floor((cap - hitWidth - gaps * ell) / gaps);
  const spans: Array<[number, number]> = [];
  for (const [start, end] of safe) {
    const from = fitLeft(start, context);
    const prev = spans[spans.length - 1];
    if (prev && from <= prev[1]) prev[1] = Math.max(prev[1], end);
    else spans.push([from, end]);
  }
  const last = spans[spans.length - 1];
  last[1] = fitRight(last[1], context);

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
 * 片段（name 全等；category 0925 树化后 fieldText 是「叶子 + 所属一级」拼接，展示
 * 只取叶子前缀段、window 0 对齐，落在一级段的命中被安全裁掉；type 展示中文标签、
 * 取拼接串中其出现位置起的窗口），定位不到（如 -1）时整段无高亮，
 * 绝不把拼接串原样铺到 UI 上。
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

/** 取 name 字段在全名坐标系上的命中区间（无命中 = 空数组，窗口化据此门控，C-6c①）。 */
function nameRangesFor(matches: readonly SkillFieldMatch[]): Array<[number, number]> {
  return matches.find((entry) => entry.field === 'name')?.ranges ?? [];
}

/** 单条命中 → 行计划。duplicateNames 判消歧；matches 供高亮投影。 */
export function pickerRowPlan(
  hit: SkillSearchHit,
  duplicateNames: ReadonlySet<string>,
): PickerRowPlan {
  const { skill, matches } = hit;
  const duplicate = duplicateNames.has(skill.name);
  const typeLabel = SKILL_TYPE_META[skill.type].label;
  // type 的 D-1 待匹配文本是 `${type} ${label}`；展示只取中文标签那一段。
  const typeWindow = `${skill.type} `.length;
  const nameRanges = nameRangesFor(matches);
  return {
    skill,
    label: skill.name,
    suffix: duplicate ? ` ·${skill.id.slice(-6)}` : '',
    nameRanges,
    nameSegments: highlightSegments(skill.name, nameRanges),
    categorySegments: segmentsForField(matches, 'category', categoryDisplay(skill), 0),
    typeSegments: segmentsForField(matches, 'type', typeLabel, typeWindow),
  };
}

/**
 * C-6c①②③ 行级名称分段（PickerRow 拿到本行名称盒实测宽后调用）：
 * - 窗口化只在名称字段确实有命中时启用——零命中没有要保护的可视内容，恒全名直出。
 *   （走查实测：无命中也被按预算截，造出「两行视觉相同」与没必要的省略号；分组态
 *   根本没有命中，天然落入此分支。）
 * - 有命中：预算 = 本行盒宽换算（nameBudgetFromBoxPx），首次未测到宽（boxPx≤0）
 *   退化为全名不截；窗口文本按显示宽度 ≤ 预算，命中必落盒内。
 * - 消歧后缀不占此预算：它渲染在 truncate 盒之外（shrink-0 兄弟），恒可见。
 */
export function pickerRowNameSegments(
  row: Pick<PickerRowPlan, 'label' | 'nameRanges'>,
  boxPx: number,
): HighlightSegment[] {
  if (row.nameRanges.length === 0) return highlightSegments(row.label, []);
  if (boxPx <= 0) return highlightSegments(row.label, row.nameRanges);
  const window = windowAroundHits(row.label, row.nameRanges, nameBudgetFromBoxPx(boxPx));
  return highlightSegments(window.text, window.ranges);
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
      rows: skills.map((skill) =>
        pickerRowPlan({ skill, score: 0, matches: [] }, duplicateNames),
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
): PickerFlatPlan {
  const capped = Math.max(1, Math.floor(limit));
  return {
    rows: hits.slice(0, capped).map((hit) => pickerRowPlan(hit, duplicateNames)),
    total: hits.length,
    truncated: hits.length > capped,
  };
}
