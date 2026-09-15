import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API,
  clearReadyQueue,
  issueAgent,
  newTask,
  taskStatus,
  toReady,
  type IssuedAgent,
} from './helpers/seed';
import { createTestApp, type TestApp } from './helpers/http-app';

/**
 * Cursor 外部调度脚本（scripts/cursor-agent-poll.mjs）的端到端覆盖。
 *
 * 十四章方式 ① + 验收 20 的 Cursor 子项：「系统调度脚本走 REST claim 完成一次完整的
 * 认领→回写」。脚本按 launchd 的真实用法整进程 spawn，服务是真 HTTP —— 唯一替身是
 * ATB_EXEC 指向的「工作命令」：换成一条 node 内联脚本模拟 Cursor Agent 的输出与产物。
 */

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'cursor-agent-poll.mjs');

function runScript(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

let t: TestApp;
let agent: IssuedAgent;
const issued: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
  agent = await issueAgent(t, 'cursor-poller', ['tool:cursor-rest']);
  issued.push(agent.token, t.uiToken);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('Cursor 调度脚本：完整认领→回写（验收 20）', () => {
  it('队列空时静默退出 0，不产生任何 Run', async () => {
    await clearReadyQueue(t);
    const before = await t.prisma.taskRun.count();
    const { code, out } = await runScript({
      ATB_URL: t.origin,
      ATB_AGENT_TOKEN: agent.token,
      ATB_EXEC: 'node -e "process.exit(1)"',
    });
    expect(code).toBe(0);
    expect(out).toContain('队列为空');
    expect(await t.prisma.taskRun.count()).toBe(before);
  });

  it('认领 → 心跳/日志 → 产物上传 → complete，任务进待审核', async () => {
    await clearReadyQueue(t);
    const id = await newTask(t, {
      title: 'Cursor 调度脚本全链路',
      required_capabilities: ['tool:cursor-rest'],
      description: '先把 README 的接入段落重写',
    });
    await toReady(t, id);

    // 模拟 Cursor Agent：打印几行日志、生成一个补丁文件作为待上传产物。
    const workdir = mkdtempSync(path.join(tmpdir(), 'atb-cursor-'));
    writeFileSync(path.join(workdir, 'docs.patch'), '--- a/readme.md\n+++ b/readme.md\n@@ -1 +1,2 @@\n hello\n+world\n');
    const exec = [
      `node -e "`,
      `console.log('clone repo');`,
      `console.log('edit docs');`,
      `require('fs').writeFileSync(process.argv[1], '--- a/readme.md\\n+++ b/readme.md\\n@@ -1 +1,2 @@\\n hello\\n+world\\n');`,
      `" ${path.join(workdir, 'docs.patch')}`,
    ].join(' ');

    const { code, out } = await runScript({
      ATB_URL: t.origin,
      ATB_AGENT_TOKEN: agent.token,
      ATB_CAPABILITIES: 'tool:cursor-rest',
      ATB_EXEC: exec,
      ATB_ARTIFACTS_DIR: workdir,
    });
    expect(code, out).toBe(0);

    expect(await taskStatus(t, id)).toBe('REVIEW');
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    // 4.3.2：完成即清租约；current_run_id 留给审核表单定位被审的 Run。
    expect([stored.leaseId, stored.leaseExpiresAt]).toEqual([null, null]);

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: stored.currentRunId! } });
    expect(run.status).toBe('SUCCESS');
    expect(run.summary).toContain('edit docs');
    expect(run.output).toContain('clone repo');
    expect(run.agentName).toBe('cursor-poller');

    // 工作命令的输出走 append_log 进 Run 日志（type=log，不混进用户评论）。
    const logs = await t.prisma.comment.findMany({
      where: { taskId: id, type: 'log', runId: run.id },
    });
    expect(logs.map((row) => row.content).join('\n')).toContain('clone repo');

    // ATB_ARTIFACTS_DIR 里的文件被上传并被 complete 引用。
    const artifact = await t.prisma.artifact.findFirstOrThrow({ where: { taskId: id } });
    expect(artifact.type).toBe('diff');
    // 服务端按 mime 判型并把存储文件重命名为 uuid + 扩展名（20.6）；
    // 原始文件名保留在 metadata 里。
    expect(artifact.uri).toMatch(/\.patch$/);
    expect(artifact.metadata).toContain('docs.patch');
  });

  it('工作命令非零退出：fail 回写，任务落异常列并保留输出摘要', async () => {
    await clearReadyQueue(t);
    const id = await newTask(t, {
      title: 'Cursor 调度脚本失败路径',
      required_capabilities: ['tool:cursor-rest'],
    });
    await toReady(t, id);

    const { code, out } = await runScript({
      ATB_URL: t.origin,
      ATB_AGENT_TOKEN: agent.token,
      ATB_CAPABILITIES: 'tool:cursor-rest',
      ATB_EXEC: `node -e "console.error('boom: no such file'); process.exit(3)"`,
    });
    expect(code, out).toBe(1);

    expect(await taskStatus(t, id)).toBe('FAILED');
    // 4.3.2：失败同样清租约与 currentRunId，Run 按 taskId 回查。
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.stopReason).toBe('agent_reported');
    const run = await t.prisma.taskRun.findFirstOrThrow({ where: { taskId: id } });
    expect(run.status).toBe('FAILED');
    expect(run.summary).toContain('boom');
  });
});
