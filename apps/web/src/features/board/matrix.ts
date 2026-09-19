import { TASK_STATUSES, type TaskStatus } from '@/api/types';
import { COPY } from '@/lib/copy';
import { statusLabel } from '@/lib/labels';

/**
 * 4.5 拖拽矩阵在前端的**唯一一份**实现：谁想要落点，都只能问这张表——
 * - 拖拽松手 / 落点高亮：`dropStates()` 与 `dropVerdict()`（`features/board/index.tsx`）；
 * - 键盘 `←`/`→`：`keyboardTargets()`（`features/board/model.ts`）；
 * - 卡片 `⋯` 菜单：按列序问 `dropVerdict()`（`card-menu.tsx`）；
 * - 详情抽屉底部按钮：`directTransitions()`（`features/task-detail/actions.ts`）；
 * - 任务列表页行 `⋯` 菜单：`directTransitions()`（`features/task-list/index.tsx`
 *   的 `allowedTransitions()`——这里原先自己抄过一份 ✅ 边，已删；别再写回来）。
 *
 * 原型 3.3 / 3.7 的「不在前端另写一套规则」就是这条：别处不得再出现 `to:` 字面量。
 *
 * 单一来源是怎么成立的（三道编译期防线，不靠人对着表核）：
 * 1. ✅ 的目标列、动作名、danger 只在 `DIRECT_TRANSITIONS` 里写一次，矩阵的 ✅ 格由它生成；
 * 2. `RESTRICTIONS`（❌ / 🔒）每行的键类型都**排除了**该行 ✅ 已占用的目标列，
 *    「同一格既写 ✅ 又写 ❌」这种表写不出来（TS2353，改一行就能验证）；
 * 3. 对外的规则来自 `ISSUED`（全文件唯一一处 `as MatrixTarget` 就在它里面），
 *    目标列带矩阵签发标记：`dropVerdict().rule` 与 `directTransitions()` 是同一批对象，
 *    抽屉/菜单想自己挑落点（`to: 'DONE'`）就编译不过。
 *
 * 为什么在 board 里再写一份而不是 import 后端：前端产物不接 Nest 编译链
 * （`src/api/types.ts` 头注释同一理由）。这张表与 `apps/api/src/contract/transitions.ts`
 * 的 `MATRIX` 逐格一致，改动必须两边同步；服务端 `409 ILLEGAL_TRANSITION` 只是兜底，
 * 不是交互（非法落点在本地就被拦下，不发请求）。
 */
export type DragForm = 'review' | 'stop';

/** 🔒 格上的动作名（4.5 表 + 原型 3.7 列头徽标）：卡片菜单与抽屉按钮取同一串。 */
export const FORM_ACTION = { stop: '强制停止', review: '审核', reject: '驳回' } as const;

/** ✅ 流转的稳定键：矩阵给键与目标列，各处只按键贴自己那套措辞，不另写落点。 */
export type TransitionKey = 'confirm_ready' | 'withdraw' | 'retry' | 'back_to_backlog';

declare const issuedByMatrix: unique symbol;

/**
 * 「由 4.5 矩阵签发的目标列」：只有本文件里的表能产出它，外面只能经
 * `directTransitions()` / `dropVerdict().rule` 拿到。抽屉或菜单里手写 `to: 'DONE'`
 * 这类自己挑的落点会直接编译不过——原型 3.3「前端不再自行组合」到这一步才是编译器的事。
 */
export type MatrixTarget = TaskStatus & { readonly [issuedByMatrix]: true };

/** 表里手写的 ✅ 规则：`to` 还是普通状态，行类型要靠它排除该行已占用的目标列。 */
interface AuthoredRule {
  readonly key: TransitionKey;
  readonly to: TaskStatus;
  readonly label: string;
  readonly menuLabel: string;
  readonly danger?: boolean;
}

export interface TransitionRule {
  readonly key: TransitionKey;
  /** 目标列——全前端只有这一处能决定它。 */
  readonly to: MatrixTarget;
  /** 4.3 操作表 / 原型 4.9 底部按钮的逐字动作名。 */
  readonly label: string;
  /** 原型 3.3 卡片 `⋯` 菜单的措辞（菜单里要点明落到哪一列）。 */
  readonly menuLabel: string;
  /** 需要二次确认的流转。今天没有 ✅ 格是危险项；🔒 的「强制停止」在放置处标 danger。 */
  readonly danger?: boolean;
}

/**
 * 4.5 表里全部 ✅ 格，按源状态分组；组内顺序 = 原型 4.9 里主按钮在前的顺序。
 * 动作名两处不同是文档要求，不是漂移：4.9 逐字取 4.3 操作表（「撤回」「重试」），
 * 3.3 的卡片菜单要看得出动到哪列（「移回需求池」「重试到待执行」），所以拆成两个字段。
 */
export const DIRECT_TRANSITIONS = {
  BACKLOG: [{ key: 'confirm_ready', to: 'READY', label: '确认可执行', menuLabel: '确认可执行' }],
  READY: [{ key: 'withdraw', to: 'BACKLOG', label: '撤回', menuLabel: '移回需求池' }],
  RUNNING: [],
  // 8.4：人工阻塞由 Agent 端 blocked 端点产生，人工处理后的出路与异常/失败一致。
  BLOCKED: [
    { key: 'retry', to: 'READY', label: '重试', menuLabel: '重试到待执行' },
    { key: 'back_to_backlog', to: 'BACKLOG', label: '退回需求池', menuLabel: '移回需求池' },
  ],
  REVIEW: [],
  DONE: [],
  FAILED: [
    { key: 'retry', to: 'READY', label: '重试', menuLabel: '重试到待执行' },
    { key: 'back_to_backlog', to: 'BACKLOG', label: '退回需求池', menuLabel: '移回需求池' },
  ],
} as const satisfies Record<TaskStatus, readonly AuthoredRule[]>;

type ForbiddenReason = 'running-by-agent' | 'done-terminal' | 'illegal';

type SpecialCell =
  | { kind: 'form'; form: DragForm; action: string }
  | { kind: 'forbidden'; reason: ForbiddenReason };

type Cell = { kind: 'direct'; rule: TransitionRule } | SpecialCell;

/** 某一行里已被 ✅ 占掉的目标列。 */
type DirectTargets<F extends TaskStatus> = (typeof DIRECT_TRANSITIONS)[F][number]['to'];

/** 一行的 ❌/🔒 声明：类型上就写不出该行已经 ✅ 的目标列。 */
type Row<F extends TaskStatus> = Partial<Record<Exclude<TaskStatus, DirectTargets<F>>, SpecialCell>>;

const RUNNING_ONLY: SpecialCell = { kind: 'forbidden', reason: 'running-by-agent' };
const DONE_ONLY: SpecialCell = { kind: 'forbidden', reason: 'done-terminal' };
const FORBIDDEN: SpecialCell = { kind: 'forbidden', reason: 'illegal' };

/** 4.5 表的 ❌ / 🔒 两态（4.1 列序 = 行序）。✅ 不在这里，见 `DIRECT_TRANSITIONS`。 */
const RESTRICTIONS: { [F in TaskStatus]: Row<F> } = {
  BACKLOG: { RUNNING: RUNNING_ONLY, BLOCKED: FORBIDDEN, REVIEW: FORBIDDEN, DONE: FORBIDDEN, FAILED: FORBIDDEN },
  READY: { RUNNING: RUNNING_ONLY, BLOCKED: FORBIDDEN, REVIEW: FORBIDDEN, DONE: FORBIDDEN, FAILED: FORBIDDEN },
  RUNNING: {
    BACKLOG: RUNNING_ONLY,
    READY: RUNNING_ONLY,
    // RUNNING→BLOCKED 只由 Agent 端 POST /tasks/:id/blocked 产生（8.4），UI 不提供。
    BLOCKED: RUNNING_ONLY,
    REVIEW: RUNNING_ONLY,
    DONE: RUNNING_ONLY,
    FAILED: { kind: 'form', form: 'stop', action: FORM_ACTION.stop },
  },
  BLOCKED: { RUNNING: RUNNING_ONLY, REVIEW: FORBIDDEN, DONE: FORBIDDEN, FAILED: FORBIDDEN },
  REVIEW: {
    BACKLOG: { kind: 'form', form: 'review', action: FORM_ACTION.reject },
    READY: { kind: 'form', form: 'review', action: FORM_ACTION.reject },
    RUNNING: RUNNING_ONLY,
    BLOCKED: FORBIDDEN,
    DONE: { kind: 'form', form: 'review', action: FORM_ACTION.review },
    FAILED: FORBIDDEN,
  },
  DONE: {
    BACKLOG: DONE_ONLY,
    READY: DONE_ONLY,
    RUNNING: DONE_ONLY,
    BLOCKED: DONE_ONLY,
    REVIEW: DONE_ONLY,
    FAILED: DONE_ONLY,
  },
  FAILED: { RUNNING: RUNNING_ONLY, BLOCKED: FORBIDDEN, REVIEW: FORBIDDEN, DONE: FORBIDDEN },
};

/**
 * 矩阵签发出的 ✅ 规则：`to` 在**这唯一一处**带上 `MatrixTarget` 标记。
 * 矩阵的 ✅ 格与 `directTransitions()` 返回的是同一批对象——外面只能读，写不出第二个落点。
 */
const ISSUED = issueRules();

function issueRules(): Record<TaskStatus, readonly TransitionRule[]> {
  const out = {} as Record<TaskStatus, readonly TransitionRule[]>;
  for (const from of TASK_STATUSES) {
    out[from] = DIRECT_TRANSITIONS[from].map((rule) => ({ ...rule, to: rule.to as MatrixTarget }));
  }
  return out;
}

/** 行 = 卡片当前状态，列 = 落点列。✅ 格由 `ISSUED` 注入，其余照抄 `RESTRICTIONS`。 */
const MATRIX: Record<TaskStatus, Partial<Record<TaskStatus, Cell>>> = buildMatrix();

function buildMatrix(): Record<TaskStatus, Partial<Record<TaskStatus, Cell>>> {
  return Object.fromEntries(
    TASK_STATUSES.map((from) => {
      const row: Partial<Record<TaskStatus, Cell>> = { ...RESTRICTIONS[from] };
      for (const rule of ISSUED[from]) {
        const to: TaskStatus = rule.to;
        row[to] = { kind: 'direct', rule };
      }
      return [from, row];
    }),
  ) as Record<TaskStatus, Partial<Record<TaskStatus, Cell>>>;
}

/** `tasks.status` 是开放词表（20.2 表外值原样透传），表外值取不到行 = 没有任何落点。 */
function rowOf(from: string): Partial<Record<TaskStatus, Cell>> | undefined {
  return (TASK_STATUSES as readonly string[]).includes(from) ? MATRIX[from as TaskStatus] : undefined;
}

export type Verdict =
  | {
      kind: 'direct';
      /** ✅ 那一条规则本身：动作名与目标列只有矩阵里有，调用方直接取用。 */
      rule: TransitionRule;
    }
  | { kind: 'form'; form: DragForm; /** 3.7：🔒 目标列头出现的动作名 */ action: string }
  | { kind: 'forbidden'; /** 4.5 统一文案，前端不自拟 */ copy: string }
  | { kind: 'self' };

/** 4.5 文案表最后一行的通用禁止语（源/目标列名取 20.2 展示名，表外值走 `statusLabel` 兜底）。 */
export function illegalDragCopy(from: string, to: string): string {
  return `不能从「${statusLabel(from)}」直接拖到「${statusLabel(to)}」`;
}

function forbiddenCopy(reason: ForbiddenReason, from: string, to: string): string {
  if (reason === 'running-by-agent') {
    // 拖向与拖出「执行中」共用一句（4.5 文案表第一行）。
    return from === 'RUNNING' ? COPY.dragOutOfRunning : COPY.dragToRunning;
  }
  if (reason === 'done-terminal') return COPY.dragOutOfDone;
  return illegalDragCopy(from, to);
}

/**
 * 源 = 目标返回 `self`：不落卡、无提示（4.5 首条推论）。
 * 表外组合按 ❌ 处理（与后端 `MATRIX[from][to] ?? ILLEGAL` 同一条兜底）。
 */
export function dropVerdict(from: string, to: TaskStatus): Verdict {
  if (from === to) return { kind: 'self' };
  const row = rowOf(from);
  if (!row) return { kind: 'forbidden', copy: illegalDragCopy(from, to) };
  const cell = row[to] ?? FORBIDDEN;
  if (cell.kind === 'forbidden') {
    return { kind: 'forbidden', copy: forbiddenCopy(cell.reason, from, to) };
  }
  return cell;
}

/** 拖拽开始时一次性算出六列的可放置态（PRD 7.2 首条）。 */
export function dropStates(from: string): Record<TaskStatus, Verdict> {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, dropVerdict(from, status)])) as Record<
    TaskStatus,
    Verdict
  >;
}

/**
 * 已知目标列时问一格判定（拖拽松手、卡片菜单、`actions.move` 都是这一句）；
 * 问「这个方向有哪一列能去」用 `keyboardTargets` + `model.nextLegalColumn`（PRD 7.2）。
 */
export function stepTarget(from: string, to: TaskStatus): Verdict {
  return dropVerdict(from, to);
}

/**
 * 7.2 键盘可达的「合法目标列」：`←`/`→` 只在 ✅ / 🔒 之间走，❌ 列整列跳过。
 * 返回值按传入的列序排列，调用方按方向取最近的一列即可。
 */
export function keyboardTargets(from: string, order: readonly TaskStatus[]): TaskStatus[] {
  return order.filter((to) => {
    const verdict = dropVerdict(from, to);
    return verdict.kind === 'direct' || verdict.kind === 'form';
  });
}

const EMPTY_TRANSITIONS: readonly TransitionRule[] = [];

/**
 * 某个源状态的全部 ✅ 直接流转（4.5 里 ✅ 的那几格），按 `DIRECT_TRANSITIONS` 的组内序返回
 * （= 原型 4.9 主按钮在前）。详情抽屉的按钮（`task-detail/actions.ts`）与任务列表页行 `⋯`
 * 菜单（`task-list/index.tsx` 的 `allowedTransitions`）读的都是这一份；卡片 `⋯` 菜单按列序问
 * `dropVerdict()`，拿到的 `rule` 是**同一批对象**，只是读法不同。
 * 表外状态返回空数组 = 不给任何写入口（20.2 末段）。
 */
export function directTransitions(from: string): readonly TransitionRule[] {
  return rowOf(from) ? ISSUED[from as TaskStatus] : EMPTY_TRANSITIONS;
}
