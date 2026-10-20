import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUNNING_EDGE_ANIMATION_LIMIT,
  edgeAnimationEnabled,
  isRunningStatus,
  shouldAnimateEdge,
} from '../flow/flow-motion';

/**
 * Issue #7「流程图看不出哪些任务在运行」：运行态动效的判定与接线闸。
 *
 * web 测试没有 jsdom / @testing-library（同 flow-move-requirement.test.ts 的口径），
 * 因此「是否该动」由 flow-motion.ts 的纯函数直钉；组件侧只做源码扫描，
 * 确认 class 确实由这些判定短路挂载，而不是无条件渲染。
 */

const FLOW_DIR = join(__dirname, '..', 'flow');
const GLOBALS_CSS = join(__dirname, '..', '..', '..', 'styles', 'globals.css');

describe('isRunningStatus：只有精确 RUNNING 视为运行中', () => {
  it('RUNNING 为真', () => {
    expect(isRunningStatus('RUNNING')).toBe(true);
  });

  it('其他状态、空值、大小写变体一律为假（节点不会误挂运行态 class）', () => {
    for (const status of ['READY', 'REVIEW', 'DONE', 'FAILED', 'BLOCKED', 'running', '', null, undefined]) {
      expect(isRunningStatus(status), String(status)).toBe(false);
    }
  });
});

describe('shouldAnimateEdge：blocks + 相邻 RUNNING + 阈值内才动', () => {
  it('blocks 边任一端 RUNNING 且阈值内 → 动画', () => {
    expect(shouldAnimateEdge({ depType: 'blocks', running: true, animate: true })).toBe(true);
  });

  it('两端都不 RUNNING 的 blocks 边不动画', () => {
    expect(shouldAnimateEdge({ depType: 'blocks', running: false, animate: true })).toBe(false);
  });

  it('relates 边即使相邻 RUNNING 也保持静态', () => {
    expect(shouldAnimateEdge({ depType: 'relates', running: true, animate: true })).toBe(false);
  });

  it('同屏 RUNNING 超过阈值（animate=false）时 blocks 边也不动画', () => {
    expect(shouldAnimateEdge({ depType: 'blocks', running: true, animate: false })).toBe(false);
  });

  it('缺失 depType 的脏数据按静态处理', () => {
    expect(shouldAnimateEdge({ depType: undefined, running: true, animate: true })).toBe(false);
  });
});

describe('edgeAnimationEnabled：阈值 20，21 起关闭边动画', () => {
  it('阈值为 20，边界内开、超过即关', () => {
    expect(RUNNING_EDGE_ANIMATION_LIMIT).toBe(20);
    expect(edgeAnimationEnabled(0)).toBe(true);
    expect(edgeAnimationEnabled(20)).toBe(true);
    expect(edgeAnimationEnabled(21)).toBe(false);
    expect(edgeAnimationEnabled(200)).toBe(false);
  });

  it('21 个 RUNNING 时，原本会动的 blocks 边被阈值闸门收口为静态', () => {
    const runningCount = 21;
    expect(
      shouldAnimateEdge({
        depType: 'blocks',
        running: true,
        animate: edgeAnimationEnabled(runningCount),
      }),
    ).toBe(false);
  });
});

describe('组件与样式接线闸', () => {
  const nodeSource = readFileSync(join(FLOW_DIR, 'TaskFlowNode.tsx'), 'utf8');
  const edgeSource = readFileSync(join(FLOW_DIR, 'DependencyEdge.tsx'), 'utf8');
  const viewSource = readFileSync(join(FLOW_DIR, 'FlowBoardView.tsx'), 'utf8');
  const css = readFileSync(GLOBALS_CSS, 'utf8');

  it('TaskFlowNode：运行态 class 只在 isRunningStatus 为真时挂载', () => {
    expect(nodeSource).toContain('const running = isRunningStatus(node.status);');
    expect(nodeSource).toContain("running && 'is-running'");
    expect(nodeSource).toContain('atb-flow-node-ring');
    expect(nodeSource).toContain('atb-flow-status-dot');
  });

  it('DependencyEdge：运行中边 class 由 shouldAnimateEdge 收口', () => {
    expect(edgeSource).toContain('shouldAnimateEdge({');
    expect(edgeSource).toContain('running: data?.running === true');
    expect(edgeSource).toContain('animate: data?.animate !== false');
    expect(edgeSource).toContain("running && 'atb-flow-edge--running'");
  });

  it('FlowBoardView：注入逐边 running 与阈值 animate，RUNNING 计数走同一纯判定', () => {
    expect(viewSource).toContain('isRunningStatus(task.status)');
    expect(viewSource).toContain('edgeAnimationEnabled(runningCount)');
    expect(viewSource).toContain('running:');
    expect(viewSource).toContain('animate: animateEdges');
  });

  it('globals.css：呼吸 / 节点虚线 / 脉冲 / 边虚线 keyframes 齐全', () => {
    expect(css).toContain('.atb-flow-node.is-running');
    expect(css).toContain('@keyframes atb-flow-node-breathe');
    expect(css).toContain('@keyframes atb-flow-node-dash');
    expect(css).toContain('@keyframes atb-flow-node-pulse');
    expect(css).toContain('@keyframes atb-flow-edge-dash');
    expect(css).toContain('.react-flow__edge .atb-flow-edge--running');
  });

  it('运行态 keyframes 不写会触发布局的属性', () => {
    const sectionStart = css.indexOf('Issue #7 运行态动效');
    const sectionEnd = css.indexOf('/* reduced-motion', sectionStart);
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    const section = css.slice(sectionStart, sectionEnd);
    const keyframes = section.match(/@keyframes[\s\S]*?(?=@keyframes|$)/g) ?? [];
    expect(keyframes.length).toBe(4);
    for (const block of keyframes) {
      expect(block).not.toMatch(/(^|\n)\s*(width|height|margin|top|left|padding)\s*:/);
    }
  });

  it('reduced-motion 下运行态动画全部静止（静态虚线/运行色保留）', () => {
    const sectionStart = css.indexOf('Issue #7 运行态动效');
    const reduceStart = css.indexOf('@media (prefers-reduced-motion: reduce)', sectionStart);
    expect(reduceStart).toBeGreaterThan(sectionStart);
    const reduceBlock = css.slice(reduceStart, css.indexOf('\n}', reduceStart) + 2);
    expect(reduceBlock).toContain('animation: none !important');
    expect(reduceBlock).toContain('.atb-flow-node.is-running');
    expect(reduceBlock).toContain('.atb-flow-node-ring rect');
    expect(reduceBlock).toContain('.atb-flow-node.is-running .atb-flow-status-dot');
    expect(reduceBlock).toContain('.react-flow__edge .atb-flow-edge--running');
  });
});
