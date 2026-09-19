/**
 * flow-model.ts 纯函数验证脚本（无测试框架，node 直接跑）：
 * 用法：node scripts/verify-flow-model.mjs
 * 先用 tsc 把 flow-model.ts + types.ts 编译成 CJS 到临时目录，再 require 断言。
 * 验证点：pos 自动落位 / 自动整理 / 连线（普通块单出、decision 双分支、覆盖与自连）/
 * 删线（只清单分支）/ 删块清 next 与入口回退。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = dirname(here);
const outDir = mkdtempSync(join(tmpdir(), 'flow-model-'));

execFileSync(
  'npx',
  [
    'tsc',
    'src/features/skills/flow-model.ts',
    '--outDir',
    outDir,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
    '--skipLibCheck',
  ],
  { cwd: webRoot, stdio: 'inherit' },
);

const require = createRequire(import.meta.url);
const model = require(join(outDir, 'flow-model.js'));

let failed = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    failed += 1;
    console.error(`FAIL ${name}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function makeContent() {
  const entry = { id: 'a', kind: 'step', title: 'A' };
  const decision = {
    id: 'd',
    kind: 'decision',
    title: 'D',
    condition: 'ok?',
    next: [
      { when: '是', to: '' },
      { when: '否', to: '' },
    ],
  };
  const b = { id: 'b', kind: 'step', title: 'B' };
  const c = { id: 'c', kind: 'step', title: 'C' };
  return { blocks: [entry, decision, b, c], entryBlockId: 'a' };
}

/* pos 落位：缺 pos 的块补齐，已有 pos 保留。 */
{
  const content = makeContent();
  const ensured = model.ensureBlockPos(content);
  check('ensureBlockPos 补齐所有块 pos', ensured.blocks.every((b) => b.pos && Number.isFinite(b.pos.x)), true);
  const kept = { blocks: [{ id: 'a', kind: 'step', title: 'A', pos: { x: 500, y: 300 } }, { id: 'b', kind: 'step', title: 'B' }], entryBlockId: 'a' };
  const ensured2 = model.ensureBlockPos(kept);
  check('ensureBlockPos 保留已有 pos', ensured2.blocks[0].pos, { x: 500, y: 300 });
  const overlap = {
    blocks: [
      { id: 'b', kind: 'step', title: 'B' },
      { id: 'a', kind: 'step', title: 'A', pos: { x: 256, y: 0 } },
    ],
    entryBlockId: 'a',
  };
  const ensured3 = model.ensureBlockPos(overlap);
  check(
    'ensureBlockPos 网格点撞已有节点时下移',
    ensured3.blocks[0].pos.y > 0 && ensured3.blocks[0].pos.x === 256,
    true,
  );
}

/* 自动整理：覆盖全部 pos。 */
{
  const content = {
    blocks: [
      { id: 'a', kind: 'step', title: 'A', pos: { x: 999, y: 999 } },
      { id: 'b', kind: 'step', title: 'B' },
    ],
    entryBlockId: 'a',
  };
  const laid = model.autoLayoutBlocks(content);
  check('autoLayoutBlocks 覆盖旧 pos', laid.blocks[0].pos, { x: 0, y: 0 });
  check('autoLayoutBlocks 入口在 0 列', laid.blocks[1].pos.x > laid.blocks[0].pos.x, true);
}

/* 连线：普通块单出（写 next[0]），decision 按分支。 */
{
  const content = makeContent();
  const s1 = model.setEdgeTarget(content, 'a', 0, 'd');
  check('普通块连线写 next[0]', s1.blocks[0].next, [{ when: '', to: 'd' }]);
  const s2 = model.setEdgeTarget(s1, 'd', 0, 'b');
  const s3 = model.setEdgeTarget(s2, 'd', 1, 'c');
  check('decision 分支1', s3.blocks[1].next[0], { when: '是', to: 'b' });
  check('decision 分支2', s3.blocks[1].next[1], { when: '否', to: 'c' });
  check('outgoingEdges 展开', model.outgoingEdges(s3), [
    { fromId: 'a', branchIndex: 0, toId: 'd', when: '' },
    { fromId: 'd', branchIndex: 0, toId: 'b', when: '是' },
    { fromId: 'd', branchIndex: 1, toId: 'c', when: '否' },
  ]);
  const s4 = model.setEdgeTarget(s3, 'd', 0, 'c');
  check('重复连线覆盖旧目标', s4.blocks[1].next[0], { when: '是', to: 'c' });
  check('不允许连自己', model.setEdgeTarget(s4, 'd', 0, 'd'), s4);
  const s5 = model.setEdgeTarget(s3, 'd', 0, 'nonexistent');
  check('目标不存在原样返回', s5, s3);
}

/* 删线：只清单个分支，保留 when。 */
{
  const content = makeContent();
  const s = model.setEdgeTarget(model.setEdgeTarget(model.setEdgeTarget(content, 'a', 0, 'd'), 'd', 0, 'b'), 'd', 1, 'c');
  const r1 = model.removeEdgeTarget(s, 'd', 0);
  check('删分支1 只清该分支', r1.blocks[1].next, [
    { when: '是', to: '' },
    { when: '否', to: 'c' },
  ]);
  const r2 = model.removeEdgeTarget(r1, 'a', 0);
  check('删普通块连线 to 置空', r2.blocks[0].next, [{ when: '', to: '' }]);
}

/* 删块：清指向它的 next，入口回退。 */
{
  const content = makeContent();
  const s = model.setEdgeTarget(model.setEdgeTarget(model.setEdgeTarget(content, 'a', 0, 'd'), 'd', 0, 'b'), 'd', 1, 'c');
  const r1 = model.removeBlockWithRefs(s, 'b');
  check('删块清空指向它的分支 to', r1.blocks[1].next[0].to, '');
  check('删块移除本体', r1.blocks.some((b) => b.id === 'b'), false);
  check('非入口删除不影响 entryBlockId', r1.entryBlockId, 'a');
  const r2 = model.removeBlockWithRefs(r1, 'a');
  check('删入口块回退到剩余第一个', r2.entryBlockId, 'd');
}

rmSync(outDir, { recursive: true, force: true });
if (failed > 0) {
  console.error(`\n${failed} 个断言失败`);
  process.exit(1);
}
console.log('\n全部通过');
