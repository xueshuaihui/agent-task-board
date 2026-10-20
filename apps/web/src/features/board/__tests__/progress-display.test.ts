import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROGRESS_STALE_AFTER_MS, progressReportDisplay } from '../progress-staleness';

/**
 * Issue #6「最后上报时间 / 停滞提示」的判据与接线闸。
 *
 * web 测试没有 jsdom / @testing-library（口径同 flow-running-motion.test.ts）：
 * 时间判据由 progress-staleness.ts 的纯函数直钉，组件侧只做源码扫描，
 * 确认卡片确实读 `progress_updated_at`、节点确实按 `progress` 画条，
 * 且停滞提示只是一行文案、没有接任何状态迁移入口。
 */

const NOW = Date.parse('2026-10-10T08:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const BOARD_DIR = join(__dirname, '..');
const WEB_SRC = join(BOARD_DIR, '..', '..');

describe('progressReportDisplay：无时间戳不显示、5 分钟起提示停滞', () => {
  it('无时间戳（历史 Run）→ 不显示，也不提示停滞', () => {
    for (const value of [null, undefined]) {
      expect(progressReportDisplay(value, NOW)).toEqual({ text: null, stale: false, ageMs: null });
    }
  });

  it('非法时间 → 不显示（不伪造最后上报时间）', () => {
    for (const value of ['', 'not-a-date', '2026-13-40T99:99:99Z']) {
      expect(progressReportDisplay(value, NOW)).toEqual({ text: null, stale: false, ageMs: null });
    }
  });

  it('阈值是 5 分钟：2 分钟只显示相对时间', () => {
    const info = progressReportDisplay(ago(2 * 60_000), NOW);
    expect(PROGRESS_STALE_AFTER_MS).toBe(5 * 60_000);
    expect(info.text).toBe('最后上报 2 分钟前');
    expect(info.stale).toBe(false);
  });

  it('<5 分钟不提示停滞（4 分 59 秒仍在阈值内）', () => {
    expect(progressReportDisplay(ago(4 * 60_000 + 59_000), NOW).stale).toBe(false);
  });

  it('≥5 分钟提示可能已停滞（边界 5 分钟即提示）', () => {
    expect(progressReportDisplay(ago(PROGRESS_STALE_AFTER_MS), NOW).stale).toBe(true);
    expect(progressReportDisplay(ago(31 * 60_000), NOW).stale).toBe(true);
  });

  it('未来时间（本地时钟小幅抖动）不判停滞', () => {
    const info = progressReportDisplay(ago(-30_000), NOW);
    expect(info.text).toBe('最后上报 刚刚');
    expect(info.stale).toBe(false);
  });
});

describe('组件接线闸：卡片读时间戳、节点画进度条', () => {
  const types = readFileSync(join(WEB_SRC, 'api', 'types.ts'), 'utf8');
  const card = readFileSync(join(BOARD_DIR, 'task-card-view.tsx'), 'utf8');
  const node = readFileSync(join(BOARD_DIR, 'flow', 'TaskFlowNode.tsx'), 'utf8');
  const view = readFileSync(join(BOARD_DIR, 'flow', 'FlowBoardView.tsx'), 'utf8');

  it('TaskCard 带上 progress_updated_at: string | null', () => {
    expect(types).toMatch(/interface TaskCard \{[\s\S]*?progress_updated_at: string \| null;/);
  });

  it('RUNNING 卡片读取 progress_updated_at，渲染最后上报与橙色停滞提示', () => {
    expect(card).toContain('card.progress_updated_at');
    expect(card).toContain('function ProgressReportLine({ at }: { at: string | null })');
    expect(card).toContain('progressReportDisplay(at, now)');
    expect(card).toContain('最后上报');
    expect(card).toContain('可能已停滞');
    expect(card).toContain('text-status-running');
  });

  it('停滞提示是纯展示：行组件只收时间戳，没有 actions / 状态迁移入口', () => {
    const start = card.indexOf('function ProgressReportLine');
    const end = card.indexOf('/** 30s', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const line = card.slice(start, end);
    expect(line).not.toContain('actions');
    expect(line).not.toContain('mutat');
    expect(line).not.toContain('transition');
  });

  it('流程图节点进度非 null 时画细条 + 百分比，简化态画更细的小条', () => {
    expect(node).toContain('progressPercent(node.progress)');
    expect(node).toContain('NodeProgressTrack');
    expect(node).toContain('atb-flow-progress');
    expect(node).toContain('{percent}%');
    expect(node).toContain('title={progressTitle}');
    expect(node).toContain('title={progressTitle} thin');
  });

  it('节点高度契约未变（88 / 44），进度条只在既有盒子内压缩间距', () => {
    expect(node).toContain('FLOW_NODE_HEIGHT = 88');
    expect(node).toContain('FLOW_NODE_SIMPLE_HEIGHT = 44');
  });

  it('FlowBoardView 把 progress 与 progressUpdatedAt 一起注入节点数据', () => {
    expect(view).toContain('progress: node.progress');
    expect(view).toContain('progressUpdatedAt: cardById.get(node.id)?.progress_updated_at ?? null');
  });
});
