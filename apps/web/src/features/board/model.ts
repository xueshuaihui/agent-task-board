import type { CardArtifact, BoardColumn, FieldDef, TaskCard, TaskStatus } from '@/api/types';
import { BOARD_COLUMN_ORDER } from '@/api/types';
import type { FilterState } from '@/app/store/filters';
import { keyboardTargets } from './matrix';

/**
 * 看板的呈现规则（PRD 4.1 列显示规则 + 原型 3.1/3.2/3.3），只放纯函数：
 * 数据来自 `useBoard`（20.7 按状态分列快照），列内顺序**不在前端重排**（原型 3.2「排序」段：
 * 列内顺序由服务端按 5.6 抓取顺序固定，前端重排会和 Agent 实际领取顺序对不上）。
 */

/** 4.1：列 = 状态全集、固定顺序（§6.1 加 BLOCKED 后 7 列，20.7）。 */
export const COLUMN_ORDER: readonly TaskStatus[] = BOARD_COLUMN_ORDER;

/** 卡片标签上限（超出并入 `+N`：248px 宽度放不下第四个）。 */
export const CARD_TAG_LIMIT = 3;
/** 原型 3.3：产物图标最多 4 个，第 5 个起并入 `+N`。 */
export const CARD_ARTIFACT_LIMIT = 4;
/** 交付口径：卡片最多 2 个自定义字段。 */
export const CARD_FIELD_LIMIT = 2;
/** 原型 3.3：剩余 < 2 分钟倒计时转红。 */
export const LEASE_DANGER_MS = 120_000;

/** `tasks.status` 是字符串（20.2 表外值原样透传），矩阵只认六个已知值。 */
export function knownStatus(status: string): TaskStatus | null {
  return (COLUMN_ORDER as readonly string[]).includes(status) ? (status as TaskStatus) : null;
}

/**
 * PRD 7.2 键盘可达：`←`/`→` 从当前列出发，取该方向上**最近**的合法目标列
 * （4.5 的 ✅ 与 🔒 都算合法，❌ 整列跳过）。判定全在 `matrix.ts`，这里只按列序挑一列。
 * `keyboardTargets` 的返回已按列序升序：向右取第一个越过当前列的，向左取最后一个未越过的。
 * 表外状态与该方向无合法列都返回 null（调用方不发流转请求）。
 */
export function nextLegalColumn(from: string, step: 1 | -1): TaskStatus | null {
  const status = knownStatus(from);
  if (!status) return null;
  const index = COLUMN_ORDER.indexOf(status);
  const ahead = keyboardTargets(from, COLUMN_ORDER).filter(
    (to) => (COLUMN_ORDER.indexOf(to) - index) * step > 0,
  );
  if (ahead.length === 0) return null;
  return step === 1 ? ahead[0] : ahead[ahead.length - 1];
}

/**
 * 该方向上的相邻列（越界返回 null）。只用来把「这个方向没地方去」交给
 * `actions.move`——它跑同一个判定，于是 Toast 出 4.5 的统一文案，而不是按键无声失败。
 */
export function neighbourColumn(from: string, step: 1 | -1): TaskStatus | null {
  const status = knownStatus(from);
  if (!status) return null;
  return COLUMN_ORDER[COLUMN_ORDER.indexOf(status) + step] ?? null;
}

/**
 * 「默认视图」的判定：`view=all` 且看板的六个筛选维度全空
 * （§19.14 起 groups 维已下线，不进判定）。
 *
 * G-5（2026-09-24 用户拍板）起，这一位**不再参与列宽/折叠**：列不随筛选结果折叠，
 * 七列在任何视图下恒等分（`BoardColumnView` 恒 `min-w-[180px] flex-1`），空列照常渲染
 * 「暂无任务」。它只剩一个消费者——`index.tsx` 的「整张看板空（`total === 0`）才用
 * 页面级空态替掉列区」：筛选后 0 条不是「没活」，该看到的是七列七个空态，不是整页空态。
 */
export function isDefaultBoardView(
  filters: Pick<
    FilterState,
    'view' | 'priority' | 'type' | 'tags' | 'requirements' | 'agents' | 'customFields'
  >,
): boolean {
  return (
    filters.view === 'all' &&
    filters.priority.length === 0 &&
    filters.type.length === 0 &&
    filters.tags.length === 0 &&
    filters.requirements.length === 0 &&
    filters.agents.length === 0 &&
    Object.keys(filters.customFields).length === 0
  );
}

/**
 * 3.4「已筛 N 项」的 N：只数看板真会带进 `GET /board` 的条件。
 * 基座的 `activeFilterCount` 还包含状态/关键词/归档三组（只有列表页用），直接拿过来会虚报。
 * §19.14：groups 维已从看板下线（不进看板请求），这里同步不数。
 */
export function boardFilterCount(
  filters: Pick<
    FilterState,
    'priority' | 'type' | 'tags' | 'requirements' | 'agents' | 'customFields'
  >,
): number {
  return (
    filters.priority.length +
    filters.type.length +
    filters.tags.length +
    filters.requirements.length +
    filters.agents.length +
    Object.keys(filters.customFields).length
  );
}

/** 6.9：卡片只画 `show_on_card` 且仍启用的字段，按 `sort_order`，最多 2 个。 */
export function cardFieldEntries(card: TaskCard, defs: readonly FieldDef[]): { key: string; label: string; text: string }[] {
  const entries: { key: string; label: string; text: string }[] = [];
  for (const def of defs) {
    if (!def.enabled || !def.show_on_card) continue;
    if (!(def.key in card.custom_fields)) continue;
    const text = formatCardValue(card.custom_fields[def.key], def);
    if (!text) continue;
    entries.push({ key: def.key, label: def.label, text });
    if (entries.length >= CARD_FIELD_LIMIT) break;
  }
  return entries;
}

/** 20.10 值契约 → 一行文本。数组去重后顿号连接，布尔按字段名渲染「是/否」。 */
export function formatCardValue(value: unknown, def?: FieldDef): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、');
  if (typeof value === 'number') return String(value);
  const text = String(value);
  if (def?.type === 'bool') return text === 'true' || text === '1' ? '是' : '否';
  return text;
}

/** 5.3 阻塞展示：`blocked.count > 0` 即画锁角标（原型 3.3「待执行（阻塞）」）。 */
export function blockedText(count: number): string {
  return `依赖 ${count} 个未完成`;
}

export function blockedTip(by: readonly { id: string; title: string }[], count: number): string {
  const names = by.slice(0, 5).map((item) => `${item.id} ${item.title}`);
  const rest = count - names.length;
  return names.length === 0 ? blockedText(count) : names.join('；') + (rest > 0 ? `；等 ${count} 个` : '');
}

/** 3.3：卡片产物图标最多 4 个，其余并 `+N`（N 用 `artifact_count` 真实总数）。 */
export function artifactOverflow(artifacts: readonly CardArtifact[], total: number): { shown: CardArtifact[]; extra: number } {
  const shown = artifacts.slice(0, CARD_ARTIFACT_LIMIT);
  return { shown, extra: Math.max(0, total - shown.length) };
}

export function tagOverflow(tags: readonly string[]): { shown: string[]; extra: number } {
  const shown = tags.slice(0, CARD_TAG_LIMIT);
  return { shown, extra: Math.max(0, tags.length - shown.length) };
}

/**
 * 4.4：「执行中」列按 Token 分组显示当前 RUNNING 数量（前端从 `agent_name` 聚合，
 * 后端不额外下发），只用于排查孤儿租约，不构成任何限制。
 */
export function groupRunningByToken(tasks: readonly TaskCard[]): { agent: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const agent = task.agent_name ?? '未署名';
    counts.set(agent, (counts.get(agent) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([agent, count]) => ({ agent, count }))
    .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent));
}

/** 3.1：列底「查看全部 →」——DONE/REVIEW 常驻（列底入口），其余列只在真有未渲染卡片时出现。 */
export function showsSeeAll(column: Pick<BoardColumn, 'status' | 'count' | 'has_more' | 'tasks'>): boolean {
  if (column.has_more) return true;
  if (column.status === 'DONE' || column.status === 'REVIEW') return column.count > 0;
  return false;
}

/** 3.4 视图预设的展示顺序与中文名（6.2 第 5 条）。 */
export const VIEW_ORDER = [
  { view: 'all', label: '全部' },
  { view: 'review', label: '待我审核' },
  { view: 'claimable', label: '可领取' },
  { view: 'blocked', label: '已阻塞' },
  { view: 'failed', label: '异常' },
] as const;
