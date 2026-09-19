import type { SkillBlock, SkillContent } from './types';

/**
 * 流程图画布的纯函数模型（可编辑版流程图视图专用，UI 在 skill-flow-editor.tsx）：
 * - pos 读写：块没有坐标时用 BFS 分层网格落位（入口为第 0 列，成环/游离块排最后一列）；
 * - 连线读写：全部落在 next 指针上，普通块单出（next[0]），decision 等多分支块按
 *   branchIndex 对应 next[i].to；删分支线只清那个分支（to 置空，保留 when 文案）；
 * - 删块：连带清理指向它的 next，入口被删时回退到剩余第一个块。
 *
 * 这些函数不碰 React，供画布与验证脚本复用。
 */

export interface FlowPos {
  x: number;
  y: number;
}

export const FLOW_NODE_WIDTH = 168;
export const FLOW_NODE_HEIGHT = 52;
export const FLOW_COL_GAP = 88;
export const FLOW_ROW_GAP = 28;

/** BFS 深度（入口为 0，沿 next 传播；不可达的块统一放最后一列）。 */
function bfsDepths(content: SkillContent): Map<string, number> {
  const byId = new Map(content.blocks.map((block) => [block.id, block]));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  const entry =
    content.entryBlockId && byId.has(content.entryBlockId)
      ? content.entryBlockId
      : (content.blocks[0]?.id ?? null);
  if (entry) {
    depth.set(entry, 0);
    queue.push(entry);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const level = depth.get(queue[head]) ?? 0;
    for (const next of byId.get(queue[head])?.next ?? []) {
      if (next.to && byId.has(next.to) && !depth.has(next.to)) {
        depth.set(next.to, level + 1);
        queue.push(next.to);
      }
    }
  }
  const orphanDepth = (depth.size ? Math.max(...depth.values()) : 0) + 1;
  for (const block of content.blocks) {
    if (!depth.has(block.id)) depth.set(block.id, orphanDepth);
  }
  return depth;
}

/** BFS 分层网格坐标（列 = 深度，行 = 同层出现顺序）。 */
function gridPos(depth: Map<string, number>, block: SkillBlock): FlowPos {
  const level = depth.get(block.id) ?? 0;
  const sameColumn = [...depth.entries()]
    .filter(([, value]) => value === level)
    .map(([id]) => id);
  const rowIndex = Math.max(0, sameColumn.indexOf(block.id));
  return {
    x: level * (FLOW_NODE_WIDTH + FLOW_COL_GAP),
    y: rowIndex * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP),
  };
}

function withPos(block: SkillBlock, pos: FlowPos): SkillBlock {
  return { ...block, pos: { x: Math.round(pos.x), y: Math.round(pos.y) } };
}

function rectsOverlap(a: FlowPos, b: FlowPos): boolean {
  return (
    a.x < b.x + FLOW_NODE_WIDTH &&
    b.x < a.x + FLOW_NODE_WIDTH &&
    a.y < b.y + FLOW_NODE_HEIGHT &&
    b.y < a.y + FLOW_NODE_HEIGHT
  );
}

/**
 * 给缺 pos 的块补坐标：已有 pos 的块原样保留，缺的按 BFS 网格落位；
 * 网格点与已有节点重叠时向下顺移，直到不撞。
 */
export function ensureBlockPos(content: SkillContent): SkillContent {
  if (content.blocks.every((block) => block.pos)) return content;
  const depth = bfsDepths(content);
  const placed: FlowPos[] = content.blocks
    .filter((block) => block.pos)
    .map((block) => block.pos as FlowPos);
  const blocks = content.blocks.map((block) => {
    if (block.pos) return block;
    let pos = gridPos(depth, block);
    while (placed.some((other) => rectsOverlap(pos, other))) {
      pos = { x: pos.x, y: pos.y + FLOW_NODE_HEIGHT + FLOW_ROW_GAP };
    }
    placed.push(pos);
    return withPos(block, pos);
  });
  return { ...content, blocks };
}

/** 自动整理：覆盖全部 pos，按 BFS 分层网格重排（显式按钮触发，直接覆盖不确认）。 */
export function autoLayoutBlocks(content: SkillContent): SkillContent {
  const depth = bfsDepths(content);
  return {
    ...content,
    blocks: content.blocks.map((block) => withPos(block, gridPos(depth, block))),
  };
}

/** 画布渲染用的一条边：fromId 的第 branchIndex 个分支指向 toId（to 为空的跳过）。 */
export interface FlowEdgeRef {
  fromId: string;
  branchIndex: number;
  toId: string;
  when: string;
}

/** 展开所有块的有效连线（next[i].to 非空才是一条边）。 */
export function outgoingEdges(content: SkillContent): FlowEdgeRef[] {
  const result: FlowEdgeRef[] = [];
  for (const block of content.blocks) {
    (block.next ?? []).forEach((next, branchIndex) => {
      if (next.to) {
        result.push({ fromId: block.id, branchIndex, toId: next.to, when: next.when });
      }
    });
  }
  return result;
}

function findBlock(content: SkillContent, id: string): SkillBlock | undefined {
  return content.blocks.find((block) => block.id === id);
}

/**
 * 连线：fromId 的第 branchIndex 个分支指向 toId。
 * - 不允许连自己（原样返回）；
 * - 目标块不存在时原样返回；
 * - 重复连线（同锚点再拖一条）直接覆盖旧目标；
 * - 普通块（next 为空/单分支）写 next[0]，保留原有 when（没有则补空串）。
 */
export function setEdgeTarget(
  content: SkillContent,
  fromId: string,
  branchIndex: number,
  toId: string,
): SkillContent {
  if (fromId === toId) return content;
  const from = findBlock(content, fromId);
  if (!from || !findBlock(content, toId)) return content;
  const nexts = from.next ?? [];
  const branch = nexts[branchIndex];
  const updatedNexts =
    branchIndex === 0 && nexts.length <= 1
      ? [{ when: branch?.when ?? '', to: toId }]
      : nexts.map((item, index) => (index === branchIndex ? { ...item, to: toId } : item));
  return {
    ...content,
    blocks: content.blocks.map((block) =>
      block.id === fromId ? { ...block, next: updatedNexts } : block,
    ),
  };
}

/**
 * 删线：只清 fromId 第 branchIndex 个分支的指向（to 置空）。
 * decision 多分支删一条不影响其他分支；普通块的单线删掉后 next 变为 [{when, to:''}]，
 * 下次连线会直接覆盖。
 */
export function removeEdgeTarget(
  content: SkillContent,
  fromId: string,
  branchIndex: number,
): SkillContent {
  const from = findBlock(content, fromId);
  if (!from || !from.next?.[branchIndex]) return content;
  const next = from.next.map((item, index) => (index === branchIndex ? { ...item, to: '' } : item));
  return {
    ...content,
    blocks: content.blocks.map((block) => (block.id === fromId ? { ...block, next } : block)),
  };
}

/** 删块：移除块本体 + 清掉所有指向它的 next（to 置空），入口被删回退到剩余第一个块。 */
export function removeBlockWithRefs(content: SkillContent, blockId: string): SkillContent {
  const blocks = content.blocks
    .filter((block) => block.id !== blockId)
    .map((block) =>
      block.next?.some((next) => next.to === blockId)
        ? { ...block, next: block.next.map((next) => (next.to === blockId ? { ...next, to: '' } : next)) }
        : block,
    );
  const entryBlockId =
    content.entryBlockId === blockId ? (blocks[0]?.id ?? null) : content.entryBlockId;
  return { ...content, blocks, entryBlockId };
}

/** 设为入口块。 */
export function setEntryBlock(content: SkillContent, blockId: string): SkillContent {
  if (!findBlock(content, blockId)) return content;
  return { ...content, entryBlockId: blockId };
}

/**
 * 落库前的 content 清洗：丢掉 to 为空的 next 分支。
 *
 * 服务端 skills.dto.ts 的 blockNextSchema 要求 `to: min(1)`（空串 422），而画布/表单
 * 的多个入口会产生 to:'' 的「草稿分支」：decision 新块模板（是/否）、块编辑抽屉
 * 「添加分支」、删线（removeEdgeTarget 置空）与删块清理（removeBlockWithRefs）。
 * 这些分支本来也没有连线语义（outgoingEdges 会跳过 to 为空），不清掉会让每一次
 * PATCH（含自动保存与发布）都校验失败，用户的连线永远落不了库。
 */
export function sanitizeForSave(content: SkillContent): SkillContent {
  return {
    ...content,
    blocks: content.blocks.map((block) =>
      block.next?.some((next) => !next.to || next.to.trim() === '')
        ? { ...block, next: block.next.filter((next) => next.to && next.to.trim() !== '') }
        : block,
    ),
  };
}
