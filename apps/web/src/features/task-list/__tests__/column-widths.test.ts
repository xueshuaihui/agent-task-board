import { describe, expect, it } from 'vitest';
import {
  TASK_TABLE_COLUMNS,
  TASK_TABLE_FIXED_SUM,
  TASK_TABLE_MIN_WIDTH,
  TASK_TABLE_MIN_WIDTH_CLASS,
  TITLE_MIN_WIDTH,
} from '../columns';

/**
 * 「选筛选项后列宽变化」的结构性回归闸：任务列表走 `table-layout: fixed` + `<colgroup>`
 * 后，列宽的唯一真值是 `columns.ts`。这里锁住模型不变式——
 * 任何一列丢了显式宽度、弹性列多于一列、或改了列宽没同步整表地板字面量类，都在此红灯。
 */
describe('task list column width model (B: filter must not reflow columns)', () => {
  it('covers all 11 columns in header order', () => {
    expect(TASK_TABLE_COLUMNS.map((column) => column.key)).toEqual([
      'select',
      'id',
      'title',
      'type',
      'priority',
      'status',
      'tags',
      'agent',
      'duration',
      'updated_at',
      'actions',
    ]);
  });

  it('has exactly one elastic column (title); every other column carries an explicit width', () => {
    const elastic = TASK_TABLE_COLUMNS.filter((column) => column.width === null);
    expect(elastic.map((column) => column.key)).toEqual(['title']);
    for (const column of TASK_TABLE_COLUMNS) {
      if (column.width === null) continue;
      expect(Number.isInteger(column.width), `${column.key} width must be integer px`).toBe(true);
      // 任何定宽列至少容得下 `px-3` 内衬 + 一个最小可辨认内容。
      expect(column.width).toBeGreaterThanOrEqual(40);
    }
  });

  it('title elastic column keeps its 240px floor inside the table min width', () => {
    expect(TITLE_MIN_WIDTH).toBe(240);
    expect(TASK_TABLE_FIXED_SUM).toBe(
      TASK_TABLE_COLUMNS.reduce((sum, column) => sum + (column.width ?? 0), 0),
    );
    expect(TASK_TABLE_MIN_WIDTH).toBe(TASK_TABLE_FIXED_SUM + TITLE_MIN_WIDTH);
  });

  it('keeps the Tailwind min-width literal class in sync with the computed floor', () => {
    // `min-w-[...]` 必须作为字面量出现在源码里才会被 Tailwind 生成；
    // 改了列宽却忘了改 `TASK_TABLE_MIN_WIDTH_CLASS` 时，这条断言负责拦下。
    expect(TASK_TABLE_MIN_WIDTH_CLASS).toBe(`min-w-[${TASK_TABLE_MIN_WIDTH}px]`);
  });

  it('sortable headers match the 20.3 server whitelist columns', () => {
    expect(
      TASK_TABLE_COLUMNS.filter((column) => column.sortField).map((column) => column.key),
    ).toEqual(['id', 'priority', 'status', 'updated_at']);
  });
});
