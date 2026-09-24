import type { Skill } from './types';
import { SKILL_TYPE_META, UNCATEGORIZED_LABEL } from './meta';

/**
 * D-1 技能多维模糊匹配（纯函数、零依赖、不进 React）。
 *
 * 口径来自用户裁定：列表已一次性全量在手（useSkills），匹配全在客户端做，零额外请求；
 * 切词 AND + 子序列 + 全字段，不引拼音词典、不加编辑距离。
 */

export type SkillSearchField = 'name' | 'description' | 'category' | 'type' | 'id' | 'tags';

export interface SkillFieldMatch {
  field: SkillSearchField;
  /** 实际被匹配的展示文本（如 type 字段是 'workflow 工作流'，category 未分类是 '未分类'）。 */
  text: string;
  /** 落在 text 上的 [start, end) 半开区间：不重叠、按 start 升序，供调用方渲染高亮。 */
  ranges: Array<[number, number]>;
}

export interface SkillSearchHit {
  skill: Skill;
  score: number;
  matches: SkillFieldMatch[];
}

const TIER_PREFIX = 3;
const TIER_SUBSTRING = 2;
const TIER_SUBSEQUENCE = 1;

/** 字段顺序即并列时的胜出顺序（靠前的字段赢），保证结果完全确定。 */
const FIELD_ORDER: readonly SkillSearchField[] = [
  'name',
  'category',
  'tags',
  'type',
  'id',
  'description',
];

const FIELD_WEIGHT: Record<SkillSearchField, number> = {
  name: 3,
  category: 2,
  tags: 2,
  type: 1.5,
  id: 1,
  description: 1,
};

/** 单 token 在单字段上的命中结果。 */
interface TokenMatch {
  tier: number;
  ranges: Array<[number, number]>;
}

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

/**
 * 三档取最优：前缀 > 子串 > 子序列。子序列按码点逐个后移查找，
 * 逐个字符出单位区间后合并（相邻命中连成段），因此 'ocr' 能命中「办公」。
 */
function matchToken(lowerText: string, token: string): TokenMatch | null {
  if (!lowerText || !token) return null;

  const occurrences: Array<[number, number]> = [];
  for (let at = lowerText.indexOf(token); at >= 0; at = lowerText.indexOf(token, at + token.length)) {
    occurrences.push([at, at + token.length]);
  }
  if (occurrences.length > 0) {
    return { tier: lowerText.startsWith(token) ? TIER_PREFIX : TIER_SUBSTRING, ranges: occurrences };
  }

  const units: Array<[number, number]> = [];
  let cursor = 0;
  for (const char of Array.from(token)) {
    const at = lowerText.indexOf(char, cursor);
    if (at < 0) return null;
    units.push([at, at + char.length]);
    cursor = at + char.length;
  }
  return { tier: TIER_SUBSEQUENCE, ranges: mergeRanges(units) };
}

/**
 * 各字段的待匹配文本。id 冗余拼上后 6 位：重名技能在 UI 上就是靠这个后缀消歧的，
 * 用户看得见也就照着搜。
 */
function fieldTexts(skill: Skill): Array<{ field: SkillSearchField; text: string; lower: string }> {
  const texts: Record<SkillSearchField, string> = {
    name: skill.name,
    description: skill.description,
    category: skill.category === '' ? UNCATEGORIZED_LABEL : skill.category,
    type: `${skill.type} ${SKILL_TYPE_META[skill.type].label}`,
    id: `${skill.id} ${skill.id.slice(-6)}`,
    tags: skill.tags.join(' '),
  };
  return FIELD_ORDER.map((field) => ({ field, text: texts[field], lower: texts[field].toLowerCase() }));
}

/** 查询串切词：按空白（含全角空格、NBSP）切分，去空串；JS 的 \s 已覆盖 U+3000。 */
export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter((token) => token !== '');
}

function scoreSkill(
  skill: Skill,
  tokens: readonly string[],
): { score: number; matches: SkillFieldMatch[] } | null {
  const fields = fieldTexts(skill);
  const picked: Array<{ fieldIndex: number; ranges: Array<[number, number]> }> = [];
  let total = 0;

  for (const token of tokens) {
    let bestTier = 0;
    let bestWeight = 0;
    let bestIndex = -1;
    let bestRanges: Array<[number, number]> = [];
    for (let i = 0; i < fields.length; i += 1) {
      const matched = matchToken(fields[i].lower, token);
      if (!matched) continue;
      const weight = FIELD_WEIGHT[fields[i].field];
      // 先比档位、再比权重：一个 token 只在一个字段上出高亮，避免名称/描述同时闪。
      if (matched.tier > bestTier || (matched.tier === bestTier && weight > bestWeight)) {
        bestTier = matched.tier;
        bestWeight = weight;
        bestIndex = i;
        bestRanges = matched.ranges;
      }
    }
    // AND：任一 token 六面皆不命中则整条技能出局。
    if (bestIndex < 0) return null;
    total += bestTier * bestWeight;
    picked.push({ fieldIndex: bestIndex, ranges: bestRanges });
  }

  const byField = new Map<number, Array<[number, number]>>();
  for (const item of picked) {
    const bucket = byField.get(item.fieldIndex);
    if (bucket) bucket.push(...item.ranges);
    else byField.set(item.fieldIndex, [...item.ranges]);
  }

  const matches: SkillFieldMatch[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const ranges = byField.get(i);
    if (!ranges) continue;
    matches.push({ field: fields[i].field, text: fields[i].text, ranges: mergeRanges(ranges) });
  }

  // 除以 token 数：单 token 与多 token 查询的分才可比。
  return { score: total / tokens.length, matches };
}

/**
 * 查询命中结果，score 降序 → name 升序 → id 升序（完全确定）。
 * 空查询按第 7 条口径原样返回全部技能（score 0、matches 空、保持入参原序）。
 */
export function searchSkills(skills: readonly Skill[], query: string): SkillSearchHit[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) {
    return skills.map((skill) => ({ skill, score: 0, matches: [] }));
  }

  const hits: SkillSearchHit[] = [];
  for (const skill of skills) {
    const scored = scoreSkill(skill, tokens);
    if (scored) hits.push({ skill, score: scored.score, matches: scored.matches });
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.skill.name.localeCompare(b.skill.name) ||
      a.skill.id.localeCompare(b.skill.id),
  );
  return hits;
}
