import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BoardColumn, TaskCard, TaskStatus } from '@/api/types';
import type { FilterState } from '@/app/store/filters';
import { COLUMN_ORDER, isDefaultBoardView } from '../model';
import type { CardActions } from '../card-actions';

/**
 * G-5（2026-09-24 用户拍板）：看板列宽与筛选结果**解耦**——取消 PRD v1.5 §4.1/§5 的
 * 「筛选视图里空列折叠为 40px 竖条」，任何视图下七列恒常驻、恒等分，空列照常显示「暂无任务」。
 *
 * 报障原话：「添加任意筛选项筛选后列宽发生变化……有内容的列宽度变大，如果每一列都有内容
 * 不会出现」。根因是唯一的自动折叠判定 `model.ts::columnCollapsed`：它把「有没有卡片」和
 * 「是不是默认视图」喂进了列宽，于是空列掉成 40px 定宽、把剩余额度全推给有内容的列，
 * 同时把 `ColumnEmpty`「暂无任务」一起折叠掉。本片把这条规则从模型里连根删掉，
 * 所以这里的断言全部面向**新行为**（真渲染列容器），而不是「函数没了」。
 *
 * 环境口径同 `components/ui/__tests__/portal-presence-order.test.ts`：本仓 vitest 无 DOM 环境
 * （未装 jsdom / @testing-library，本片不加依赖），故用 `renderToStaticMarkup` 渲真实列组件、
 * 对 HTML 里的 class 与文本做字符串断言；浏览器里的像素宽度与三档响应式另行实测（见交付汇报）。
 */

const BOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 列组件经 `@/app/router`（`navigate`）在装配期读一次 hash，故先 stub 最小 `window`
// 再动态 import（与 `filter-prefs.test.ts` 的 stub-再-import 同一手法）。
vi.stubGlobal('window', {
  location: { hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const { BoardColumnView } = await import('../board-column');

afterAll(() => {
  vi.unstubAllGlobals();
});

/**
 * 非默认视图的最小筛选态：`priority=[3]` 一条即够（与用户报障复现口径一致）。
 * §19.14：groups 维已从看板下线，不再参与默认视图判定（切片类型里已无这一位）。
 */
const FILTERED: Pick<
  FilterState,
  'view' | 'priority' | 'type' | 'tags' | 'requirements' | 'agents' | 'customFields'
> = {
  view: 'all',
  priority: [3],
  type: [],
  tags: [],
  requirements: [],
  agents: [],
  customFields: {},
};

const NO_FILTERS = { ...FILTERED, priority: [] as number[] };

function column(status: TaskStatus, tasks: TaskCard[] = []): BoardColumn {
  return { status, label: status, count: tasks.length, has_more: false, tasks };
}

function card(status: TaskStatus): TaskCard {
  return {
    id: 'T-2001',
    title: '筛选后仍要看得见的卡',
    type: '任务',
    priority: 3,
    tags: [],
    pinned: false,
    status,
    status_label: status,
    progress: null,
    progress_msg: null,
    lease_expires_at: null,
    agent_name: null,
    run_count: 0,
    due_at: null,
    updated_at: '2026-09-24T10:00:00.000Z',
    blocked: { count: 0, by: [] },
    artifacts: [],
    artifact_count: 0,
    custom_fields: {},
    group_id: null,
    origin_type: 'user',
  };
}

const NOOP_ACTIONS = {
  open: () => {},
  togglePin: () => {},
  archive: () => {},
  stop: () => {},
  remove: () => {},
  review: () => {},
  followUp: () => {},
  create: () => {},
  copyId: () => {},
  move: () => {},
} as unknown as CardActions;

/**
 * 真实渲染一列：props 形状即 `BoardColumnViewProps`——视图/折叠入参已不存在，多传会 TS 报错。
 * 渲染会打出 motion 的「useLayoutEffect does nothing on the server」警告：这是无 DOM 环境下
 * `renderToStaticMarkup` 带 motion 组件的既有限制（与 `portal-presence-order.test.ts` 同源），
 * 与被测行为无关，刻意不做 console 静音——以免把真错误一起滤掉。
 */
function renderColumn(column: BoardColumn): string {
  return renderToStaticMarkup(
    createElement(BoardColumnView, {
      column,
      defs: [],
      actions: NOOP_ACTIONS,
      overlayOf: () => ({}),
      dropState: null,
      isOver: false,
      loading: false,
      onDraggingChange: () => {},
    }),
  );
}

/** 列容器 `<section>` 的 class（B7/G-5 的稳定选择器：弹性等分档必在）。 */
function sectionClass(html: string): string {
  const match = /<section\b[^>]*\bclass="([^"]*)"/.exec(html);
  expect(match, '列容器 <section> 必须渲染').not.toBeNull();
  return match![1];
}

function renderRow(columns: BoardColumn[]): string {
  return renderToStaticMarkup(
    createElement('div', null, ...columns.map((item) => createElement(BoardColumnView, {
      key: item.status,
      column: item,
      defs: [],
      actions: NOOP_ACTIONS,
      overlayOf: () => ({}),
      dropState: null,
      isOver: false,
      loading: false,
      onDraggingChange: () => {},
    }))),
  );
}

describe('G-5 看板列：全列常驻等分 + 空列显示「暂无任务」', () => {
  it('前提：`priority=[3]` 是非默认视图（旧模型正是在这一位把空列折叠掉的）', () => {
    expect(isDefaultBoardView(NO_FILTERS)).toBe(true);
    expect(isDefaultBoardView(FILTERED)).toBe(false);
  });

  it('非默认视图下的空列仍是弹性等分列（flex-1 + min-w-[180px]），且不落到 40px 定宽', () => {
    // 「非默认视图」这一位已经进不了列组件：列宽不再有任何视图/结果入参，
    // 所以这里渲染的就是筛选视图下真实会出现的那一列。
    const html = renderColumn(column('RUNNING', []));
    const className = sectionClass(html);
    expect(className).toMatch(/\bflex-1\b/);
    expect(className).toMatch(/min-w-\[180px\]/);
    expect(className).not.toMatch(/w-column-collapsed/);
    expect(className).not.toMatch(/\bshrink-0\b/);
    expect(html).not.toMatch(/writing-mode:vertical-rl/);
  });

  it('空列照常渲染 ColumnEmpty「暂无任务」（七个状态列逐个验）', () => {
    for (const status of COLUMN_ORDER) {
      const html = renderColumn(column(status, []));
      expect(html, `${status} 空列应显示空态`).toContain('暂无任务');
    }
  });

  it('七列数量不随筛选结果减少：一份只剩一列有卡的筛选快照仍渲出 7 个列容器、6 个空态', () => {
    expect(COLUMN_ORDER).toHaveLength(7);
    // 模拟 `GET /board?priority=3` 的回包：需求池 1 张卡，其余六列被筛空。
    // （`index.tsx::mergeColumns` 恒按 COLUMN_ORDER 铺满七列，缺列补空列，与筛选无关。）
    const snapshot = COLUMN_ORDER.map((status) =>
      column(status, status === 'BACKLOG' ? [card(status)] : []),
    );
    const row = renderRow(snapshot);
    expect(row.match(/<section\b/g)).toHaveLength(7);
    expect(row.match(/暂无任务/g)).toHaveLength(6);
    // 有卡的那一列同样吃弹性等分，不因别的列空而吞掉宽度。
    expect(sectionClass(row)).toMatch(/\bflex-1\b/);
    // 卡片本身在列内渲染出来了（空列没有把非空列一起带崩）。
    expect(row).toContain('筛选后仍要看得见的卡');
  });

  it('全空快照（筛到 0 条）下七列仍在，六个以上空态可见', () => {
    const row = renderRow(COLUMN_ORDER.map((status) => column(status, [])));
    expect(row.match(/<section\b/g)).toHaveLength(7);
    expect(row.match(/暂无任务/g)).toHaveLength(7);
  });

  it('死码闸：折叠概念在列模型与列组件里已连根删除，40px 定档 token 不再存在', () => {
    const sources = ['model.ts', 'board-column.tsx', 'index.tsx'].map(
      (name) => [name, readFileSync(join(BOARD_DIR, name), 'utf8')] as const,
    );
    for (const [name, source] of sources) {
      expect(source, `${name} 不应再引用折叠判定`).not.toMatch(/collapsed/i);
    }
    // 折叠竖条的定档 token 与其唯一消费者一起删（globals.css 注释里也不留字面量）。
    const css = readFileSync(
      resolve(BOARD_DIR, '../../styles/globals.css'),
      'utf8',
    );
    expect(css).not.toMatch(/column-collapsed/);
  });

  it('另一条规则未受影响：整张看板空（total===0 且默认视图）才替掉列区，defaultView 不再下传', () => {
    const page = readFileSync(join(BOARD_DIR, 'index.tsx'), 'utf8');
    expect(page).toMatch(/total === 0 && defaultView/);
    // `defaultView` 只剩两处：本地判定 + 上面的空态闸门；它不再作为列的 prop 下传。
    expect(page.match(/defaultView/g)).toHaveLength(2);
  });
});
