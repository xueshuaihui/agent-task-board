import { parseJson, type SkillContent } from './skills.dto';

/**
 * v0.0.4 #19（W2/W3 遗留）③ 技能引用循环检测。
 *
 * 技能内容里的 `subskill` 块通过 `skillRef` 引用另一个技能 id，技能之间因此构成一张
 * 「引用图」。若 A→B→…→A（含 A→A 自引用）成环，Agent 沿子技能下钻会无限递归，必须在写入
 * 路径拦截。口径参照 breakdown 的成环拒绝风格（`assertDraftGraph`，commit 76a1410）：
 * 组装邻接图 → DFS 找回到起点的路径 → 抛出带 chain 的冲突错误。
 *
 * 错误码 `SKILL_REF_SELF`(400) / `SKILL_REF_CYCLE`(409) 已归位 `contract/errors.ts`
 * 的 `ERROR_STATUS`（v0.0.4 W8 解冻时合并），原先的 `SkillRefException` 子类已删除，
 * 抛错方一律用普通 `new ApiException('SKILL_REF_CYCLE', ...)`。
 */

/** 空内容兜底（与 service 的 EMPTY_CONTENT 同构）：坏 JSON 读作无块，不炸图检测。 */
const EMPTY: SkillContent = { blocks: [], entryBlockId: null };

/** 从技能内容里抽出全部子技能块的 skillRef（去空、去重）。 */
export function subskillRefs(content: SkillContent | null | undefined): string[] {
  const blocks = content?.blocks ?? [];
  const refs = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'subskill' && typeof block.skillRef === 'string' && block.skillRef) {
      refs.add(block.skillRef);
    }
  }
  return [...refs];
}

/** 解析落库 content 字符串的子技能出边（读路径不炸）。 */
export function subskillRefsOfJson(raw: string | null | undefined): string[] {
  return subskillRefs(parseJson<SkillContent>(raw, EMPTY));
}

/**
 * 在「技能引用图」里找一条从 start 出发又回到 start 的环，返回环路径（首尾同为 start），
 * 无环返回 null。只报告经过 start 的环：写入路径只会新增 start 的出边，因此新引入的环
 * 必经过 start；与 start 无关的既有环不由本次写入负责（也不该由它背锅）。
 * 指向图中不存在节点的悬挂引用当作叶子（无出边），不在这里判错。
 */
export function findSkillRefCycle(
  edges: Map<string, string[]>,
  start: string,
): string[] | null {
  const stack: string[] = [start];
  const onStack = new Set<string>([start]);
  const walk = (node: string): string[] | null => {
    for (const next of edges.get(node) ?? []) {
      if (next === start) return [...stack, start];
      if (onStack.has(next)) continue; // 环不含 start：交由被写节点自身的校验兜住
      onStack.add(next);
      stack.push(next);
      const found = walk(next);
      if (found) return found;
      stack.pop();
      onStack.delete(next);
    }
    return null;
  };
  return walk(start);
}
