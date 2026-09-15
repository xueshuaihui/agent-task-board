#!/usr/bin/env node
/**
 * Cursor 外部调度脚本（十四章「首批接入」方式 ①，验收 20）。
 *
 * Cursor 没有「到点自动调 MCP 工具」的调度器，其 MCP 工具只在会话内由模型调用。
 * 本脚本供系统级调度（macOS launchd / Windows 任务计划程序）周期执行：
 * 走 REST `POST /api/v1/tasks/claim` 认领任务 → 读取历史审核意见 → 执行工作命令
 * （默认调 Cursor Agent CLI，也可换成任何命令）→ 期间心跳续租、日志回传 →
 * 成功 `complete` / 失败 `fail` 完成一次完整的认领→回写。
 *
 * 零依赖，Node ≥ 20。一次调用只处理一个任务：队列空时静默退出（exit 0），
 * 让调度器到点再来；并发执行多个任务请由调度器并行拉起本脚本（每个进程独立三元组）。
 *
 * 环境变量：
 *   ATB_URL             服务地址，默认 http://127.0.0.1:7788（平台只绑回环，15 章）
 *   ATB_AGENT_TOKEN     必填，设置页签发的 Agent Token
 *   ATB_CAPABILITIES    逗号分隔的能力串，如 "language:go,tool:maven"；缺省为 []
 *   ATB_EXEC            必填，工作命令模板。可用占位符 {title} {description} {prompt}
 *                       {task_id}。{prompt} 已拼接标题、描述与历史审核意见。
 *                       例：cursor-agent -p "{prompt}" --print
 *   ATB_ARTIFACTS_DIR   可选。命令执行完后把该目录下的文件作为产物上传
 *   ATB_TIMEOUT_SECONDS 工作命令超时（秒），默认 1800；超时按失败回写
 *   ATB_QUIET           置 1 时只在出错时输出（适合 launchd / cron 日志）
 *
 * launchd 示例（~/Library/LaunchAgents/com.atb.cursor-poll.plist）：
 *   <key>ProgramArguments</key>
 *   <array><string>/usr/bin/env</string><string>ATB_AGENT_TOKEN=...</string>
 *          <string>ATB_EXEC=cursor-agent -p "{prompt}" --print</string>
 *          <string>node</string><string>/path/to/scripts/cursor-agent-poll.mjs</string></array>
 *   <key>StartInterval</key><integer>300</integer>
 */
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const BASE = (process.env.ATB_URL ?? 'http://127.0.0.1:7788').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const TOKEN = process.env.ATB_AGENT_TOKEN ?? '';
const EXEC = process.env.ATB_EXEC ?? '';
const CAPABILITIES = (process.env.ATB_CAPABILITIES ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const ARTIFACTS_DIR = process.env.ATB_ARTIFACTS_DIR ?? '';
const TIMEOUT_SECONDS = Number(process.env.ATB_TIMEOUT_SECONDS ?? 1800);
const QUIET = process.env.ATB_QUIET === '1';

if (!TOKEN || !EXEC) {
  console.error('[cursor-poll] ATB_AGENT_TOKEN 与 ATB_EXEC 均为必填');
  process.exit(2);
}

const log = (...parts) => {
  if (!QUIET) console.log('[cursor-poll]', ...parts);
};

async function api(method, pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? undefined : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    // 非 JSON 响应原样抛出，交给调用方展示
  }
  if (!res.ok) {
    const code = json?.error?.code ?? res.status;
    throw Object.assign(new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 300)}`), {
      httpStatus: res.status,
      errorCode: typeof code === 'string' ? code : undefined,
    });
  }
  return json;
}

const MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
  ['.json', 'application/json'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.html', 'text/html'],
  ['.csv', 'text/csv'],
]);

async function uploadArtifacts(dir, key) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const uploaded = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const info = await stat(full);
    const buf = await readFile(full);
    const type =
      MIME_BY_EXT.get(path.extname(entry.name).toLowerCase()) ?? 'application/octet-stream';
    const form = new FormData();
    form.append('file', new Blob([buf], { type }), entry.name);
    form.append('task_id', key.task_id);
    form.append('run_id', key.run_id);
    form.append('lease_id', key.lease_id);
    const res = await fetch(`${API}/artifacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`上传产物 ${entry.name} → ${res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    uploaded.push({ type: body.type, uri: body.uri, name: entry.name });
    log(`产物已上传：${entry.name}（${(info.size / 1024).toFixed(1)} KB）`);
  }
  return uploaded;
}

/** 命令输出按行聚合：日志增量回传用，摘要取末尾若干行。 */
function outputLines(chunks) {
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean);
}

function fillTemplate(fields) {
  return (raw) =>
    raw
      .replaceAll('{prompt}', fields.prompt)
      .replaceAll('{title}', fields.title)
      .replaceAll('{description}', fields.description ?? '')
      .replaceAll('{task_id}', fields.task_id);
}

async function main() {
  const claim = await api('POST', '/tasks/claim', { capabilities: CAPABILITIES });
  if (!claim?.task) {
    log('队列为空，本轮不处理');
    return 0;
  }
  const task = claim.task;
  const key = {
    task_id: task.id,
    run_id: claim.lease.run_id,
    lease_id: claim.lease.lease_id,
  };
  log(`已认领 #${task.id}「${task.title}」`);

  // 十四章步骤 6：领到任务先读历史审核意见，避免重蹈上一次驳回的覆辙。
  let feedback = '';
  try {
    const fb = await api('GET', `/tasks/${task.id}/review-feedback?limit=5`);
    for (const item of fb.review_feedback ?? []) {
      feedback += `上次审核意见（${item.conclusion === 'APPROVE' ? '通过' : '驳回'}）：${item.suggestion}\n原因：${item.reason}\n详情：${item.detail ?? ''}\n`;
    }
  } catch (error) {
    log('读取审核意见失败（不阻塞执行）：', error.message);
  }

  const description = task.description ?? '';
  const prompt = [
    `任务：${task.title}`,
    description && `描述：${description}`,
    feedback && `以下是用户上一次审核时给出的意见，请务必落实：\n${feedback}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const template = fillTemplate({ title: task.title, description, task_id: task.id, prompt });
  const command = template(EXEC);

  // 心跳与日志回传：周期取服务端建议值（lease.service 返回 heartbeat_interval_seconds）。
  let heartbeatInterval = setInterval(() => {}, 1 << 30);
  let lastLogCount = 0;
  const chunks = [];
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const beat = async () => {
    try {
      const res = await api('POST', `/tasks/${key.task_id}/heartbeat`, key);
      const seconds = res?.heartbeat_interval_seconds;
      if (Number.isFinite(seconds) && seconds > 0) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = setInterval(beat, Math.max(5, seconds * 1000 - 5000));
      }
    } catch (error) {
      // 租约已失效（410）或被强制停止：继续跑没有意义，杀掉工作进程。
      log('心跳失败，终止执行：', error.message);
      child.kill('SIGTERM');
    }
  };
  heartbeatInterval = setInterval(beat, 20_000);
  beat();

  const flushLogs = async (level = 'info') => {
    const lines = outputLines(chunks);
    if (lines.length <= lastLogCount) return;
    const fresh = lines.slice(lastLogCount, lastLogCount + 500);
    lastLogCount = Math.min(lines.length, lastLogCount + 500);
    try {
      await api('POST', `/tasks/${key.task_id}/logs`, { ...key, lines: fresh, level });
    } catch (error) {
      log('日志回传失败：', error.message);
    }
  };
  const logTimer = setInterval(flushLogs, 15_000);

  const timeout = setTimeout(() => {
    log(`工作命令超过 ${TIMEOUT_SECONDS}s，按失败处理`);
    child.kill('SIGTERM');
  }, TIMEOUT_SECONDS * 1000);

  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearInterval(heartbeatInterval);
  clearInterval(logTimer);
  clearTimeout(timeout);
  // 收尾先冲刷剩余输出，complete/fail 的日志才不缺最后几行。
  await flushLogs(code === 0 ? 'info' : 'error');
  const lines = outputLines(chunks);
  const tail = lines.slice(-20).join('\n').slice(0, 20000);
  const output = lines.join('\n').slice(0, 65536);

  if (code === 0) {
    const artifacts = ARTIFACTS_DIR ? await uploadArtifacts(ARTIFACTS_DIR, key) : [];
    const res = await api('POST', `/tasks/${key.task_id}/complete`, {
      ...key,
      summary: tail || '执行完成',
      output,
      artifacts,
    });
    log(`已回写，任务进入 ${res.task_status}`);
    return 0;
  }

  const timedOut = code === null;
  await api('POST', `/tasks/${key.task_id}/fail`, {
    ...key,
    error: timedOut ? `工作命令超过 ${TIMEOUT_SECONDS}s 未完成` : `工作命令退出码 ${code}\n${tail}`,
    summary: tail || undefined,
  });
  log('已按失败回写');
  return 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error('[cursor-poll] 本轮失败：', error.message);
  process.exitCode = 1;
}
// undici 的 keep-alive 连接会挂住事件循环，CLI 一次性进程必须显式退出。
process.exit(process.exitCode ?? 0);
