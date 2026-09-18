import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportUnknownEnumValue } from '../common/unknown-enum';
import { AppLogger } from '../infra/logger';
import { statusLabel } from '../tasks/task.dto';
import { createTestApp, errorCode, type TestApp } from './helpers/http-app';
import {
  API,
  claimOk,
  clearReadyQueue,
  createFieldDef,
  issueAgent,
  newTask,
  review,
  toReady,
  triple,
  uiSender,
  type IssuedAgent,
  type Lease,
} from './helpers/seed';

/**
 * 阶段一验收清单里此前**完全没有断言**的三条（8 / 16 / 10），加上本轮修的三个缺陷
 * （38 删除级联到磁盘、42 产物丢失标记要出现在执行记录列表、43 表外枚举值要记 error 日志）。
 *
 * 单独成文件的原因：这些用例会往产物目录落真文件、也会留下一个 required 字段定义——
 * 字段定义是库级全局的，混进别的文件就会卡住别人的「拖到待执行」。
 * 建库/建应用沿用 `helpers/http-app`：临时数据目录 + 真实 AppModule + 127.0.0.1 随机端口。
 */

let t: TestApp;
let ui: ReturnType<typeof uiSender>;
/** 本文件里服务端记下的全部 error 日志正文，用来验「日志不泄漏凭证」（15 章）。 */
let errorLines: string[];

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
  errorLines = [];
  // 全局日志器是全进程唯一实例（infra/logger 的 sharedAppLogger），DI 拿到的就是它。
  vi.spyOn(t.app.get(AppLogger), 'error').mockImplementation((message: unknown) => {
    errorLines.push(String(message));
  });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

// 认领取第一个匹配候选，而「无能力要求」的任务对任何 Token 都匹配：每条用例都从空队列开始。
beforeEach(async () => {
  await clearReadyQueue(t);
  errorLines.length = 0;
});

describe('验收 8：审核三字段必填', () => {
  it('suggestion / reason / detail 任一为空（含纯空白）都是 422，任务留在待审核', async () => {
    const id = await newTask(t, { title: '审核表单的三字段' });
    await toReviewKey(id);
    const base = { conclusion: 'REJECT', return_to: 'READY', ...fullFeedback() };

    for (const field of ['suggestion', 'reason', 'detail'] as const) {
      for (const empty of ['', '   ', '\n\t']) {
        const res = await review(t, id, { ...base, [field]: empty });
        expect(res.status, `${field}=${JSON.stringify(empty)} 竟被放过了`).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(JSON.stringify(res.body.error.details)).toContain(field);
      }
    }
    // 三个字段全缺也是 422，details 三条都在。
    const nothing = await review(t, id, { conclusion: 'REJECT', return_to: 'READY' });
    expect(nothing.status).toBe(422);
    const details = JSON.stringify(nothing.body.error.details);
    for (const field of ['suggestion', 'reason', 'detail']) expect(details).toContain(field);
    // 上面这些 422 一个都没动过任务状态。
    expect((await ui.get(`${API}/tasks/${id}`)).body.status).toBe('REVIEW');
  });

  it('通过（APPROVE）时三字段为选填，留空也能直接进已完成', async () => {
    const id = await newTask(t, { title: '通过可不填意见' });
    await toReviewKey(id);
    const res = await review(t, id, { conclusion: 'APPROVE', suggestion: '', reason: '', detail: '' });
    expect(res.status, `通过留空应被放行，实际 ${res.status} ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.status).toBe('DONE');
  });
});

describe('验收 16：必填自定义字段卡住「拖到待执行」', () => {
  it('必填未填时 transition 到 READY 被拒（422），补齐后放行', async () => {
    // applies_to 锁在「缺陷」上：这条字段定义会活到本文件结束，不能去卡别的用例。
    await createFieldDef(t, {
      key: 'gap_severity',
      label: '缺口严重度',
      type: 'select',
      required: true,
      options: ['高', '低'],
      applies_to: ['缺陷'],
    });

    const id = await newTask(t, { title: '必填字段没填就想进待执行', type: '缺陷' });
    const blocked = await ui.post(`${API}/tasks/${id}/transition`, { to: 'READY' });
    expect(blocked.status).toBe(422);
    expect(errorCode(blocked)).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(blocked.body.error.details)).toContain('gap_severity');
    expect((await ui.get(`${API}/tasks/${id}`)).body.status).toBe('BACKLOG');

    // 6.9.2：创建/编辑时不拦必填，只有「拖到待执行」这条线拦——所以补值本身要能过。
    const filled = await ui.patch(`${API}/tasks/${id}`, { custom_fields: { gap_severity: '高' } });
    expect(filled.status).toBe(200);
    const moved = await ui.post(`${API}/tasks/${id}/transition`, { to: 'READY' });
    expect(moved.status).toBe(201);
    expect(moved.body.status).toBe('READY');
    expect((await ui.get(`${API}/tasks/${id}`)).body.custom_fields).toMatchObject({
      gap_severity: '高',
    });
  });
});

describe('验收 10：驳回后重领要读到审核意见', () => {
  it('再次认领的载荷里 review_feedback 第一条就是刚才那条审核意见', async () => {
    const id = await newTask(t, { title: '驳回后要看得见意见' });
    const first = await toReviewKey(id);
    const feedback = fullFeedback();
    const rejected = await review(t, id, { conclusion: 'REJECT', return_to: 'READY', ...feedback });
    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('READY');

    const agent = await issueAgent(t, `reclaim-${agentSlug(id)}`, [`tool:${id}`]);
    const claimed = await claimOk(agent, id);
    expect(claimed.task.review_feedback).toHaveLength(1);
    // 6.6 / 12 章的载荷形状：run_id + 结论 + 三字段，一条不多一条不少。
    expect(claimed.task.review_feedback[0]).toEqual({
      run_id: first.run_id,
      conclusion: 'REJECT',
      ...feedback,
    });

    const again = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...triple(claimed),
      summary: '按意见补了边界',
      artifacts: [],
    });
    expect(again.status).toBe(200);
    await approveDone(id);
  });
});

describe('验收 38：删除任务连磁盘产物目录一起删', () => {
  it('带执行记录与产物的任务删除后 `artifacts/T-xxxx/` 整目录消失，残留文件也算', async () => {
    const id = await newTask(t, { title: '删除要把产物目录带走' });
    const { agent, key } = await claimRunning(id);
    const uploaded = await uploadArtifact(agent, key, 'first line\n', 'run.txt');
    const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '产物已回写',
      artifacts: [{ type: 'text', uri: uploaded.uri, name: 'run.txt' }],
    });
    expect(done.status).toBe(200);

    const taskDir = path.join(t.dir, 'artifacts', id);
    // 上传半路断掉留下的残留：库里根本没有这一行，只有目录级清理能带走它。
    const stray = path.join(taskDir, 'R-9999-residual', 'stray.bin');
    mkdirSync(path.dirname(stray), { recursive: true });
    writeFileSync(stray, 'orphan');
    expect(readArtifact(uploaded.uri)).toContain('first line');
    expect(existsSync(stray)).toBe(true);

    const deleted = await ui.del(`${API}/tasks/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ id, deleted_runs: 1, unblocked_ids: [] });

    expect(existsSync(taskDir)).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(path.join(t.dir, uploaded.uri))).toBe(false);
    // 级联：run / artifact 行不留悬空引用，任务行本身也物理删除（4.3.1 规则 4）。
    expect(await t.prisma.taskRun.count({ where: { taskId: id } })).toBe(0);
    expect(await t.prisma.artifact.count({ where: { taskId: id } })).toBe(0);
    expect(await t.prisma.task.findUnique({ where: { id } })).toBeNull();
    // 只删这个任务的目录，产物根目录与别人的文件不能一起蒸发。
    expect(existsSync(path.join(t.dir, 'artifacts'))).toBe(true);
  });
});

describe('验收 42：产物丢失要在执行记录列表里就标出来', () => {
  it('删掉文件后列表里该产物 missing:true，任务状态不受影响；link 恒 false', async () => {
    const id = await newTask(t, { title: '产物文件被删了' });
    const { agent, key } = await claimRunning(id);
    const uploaded = await uploadArtifact(agent, key, 'log body\n', 'app.txt');
    const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '一条文本产物 + 一条外链',
      artifacts: [
        { type: 'text', uri: uploaded.uri, name: 'app.txt' },
        { type: 'link', uri: 'https://github.com/acme/app/pull/342', name: 'PR #342' },
      ],
    });
    expect(done.status).toBe(200);

    const before = await runArtifacts(id);
    expect(before).toHaveLength(2);
    expect(before.find((row) => row.type === 'text')).toMatchObject({ missing: false });
    // 20.6：link 不占磁盘，永远不算丢失。
    expect(before.find((row) => row.type === 'link')).toMatchObject({ missing: false });

    unlinkSync(path.join(t.dir, uploaded.uri));

    const after = await runArtifacts(id);
    expect(after.find((row) => row.type === 'text')).toMatchObject({ id: uploaded.id, missing: true });
    expect(after.find((row) => row.type === 'link')).toMatchObject({ missing: false });
    // 「已丢失」只是产物自身的状态：不改任务状态，也不让详情读失败。
    const detail = await ui.get(`${API}/tasks/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('REVIEW');
    expect(detail.body.artifact_count).toBe(2);
    // 与产物元信息接口同一口径（同一个判定函数，见 artifact-storage.isArtifactMissing）。
    const meta = await ui.get(`${API}/artifacts/${uploaded.id}`);
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({
      missing: true,
      preview: { enabled: false, kind: 'none', reason: 'file_missing' },
    });
  });
});

describe('验收 43 / 20.2 末段：表外枚举值要记 error 日志', () => {
  it('同一 (字段,值) 每进程只记一次，内容含表名/字段/原值', () => {
    const error = vi.fn();
    const logger = { error } as unknown as AppLogger;
    reportUnknownEnumValue('tasks', 'status', 'PENDING_REVIEW_GAP', logger);
    reportUnknownEnumValue('tasks', 'status', 'PENDING_REVIEW_GAP', logger);
    expect(error).toHaveBeenCalledTimes(1);

    reportUnknownEnumValue('tasks', 'status', 'SOMETHING_ELSE', logger);
    reportUnknownEnumValue('reviews', 'conclusion', 'PENDING_REVIEW_GAP', logger);
    expect(error).toHaveBeenCalledTimes(3);

    const [message, trace, context] = error.mock.calls[0] as [string, string | undefined, string];
    expect(message).toContain('tasks');
    expect(message).toContain('status');
    expect(message).toContain('PENDING_REVIEW_GAP');
    // 只有表名/字段/原值三段进消息：没有 trace，也没有整行记录可以夹带凭证。
    expect(trace).toBeUndefined();
    expect(context).toBe('enum-read');
  });

  it('表外状态原样透传 + 上报，已知状态不上报（DTO 侧保持无副作用）', () => {
    const report = vi.fn();
    expect(statusLabel('PENDING_REVIEW_GAP', report)).toBe('');
    expect(report).toHaveBeenCalledWith('tasks', 'status', 'PENDING_REVIEW_GAP');

    const silent = vi.fn();
    expect(statusLabel('READY', silent)).toBe('待执行');
    expect(silent).not.toHaveBeenCalled();
  });

  it('读路径不崩：正常任务过一遍详情/列表/看板，一条 error 日志也没有', async () => {
    const id = await newTask(t, { title: '日志里不该有 Token' });
    await toReady(t, id);
    expect((await ui.get(`${API}/tasks/${id}`)).status).toBe(200);
    expect((await ui.get(`${API}/tasks?status=READY&page_size=50`)).status).toBe(200);
    expect((await ui.get(`${API}/board`)).status).toBe(200);
    expect(errorLines).toEqual([]);
  });
});

describe('日志与错误体不泄漏凭证（15 章）', () => {
  it('走完上传→回写→审核→删除全链路，error 日志里没有 UI Token 也没有 Agent Token', async () => {
    const id = await newTask(t, { title: '凭证不进日志' });
    const { agent, key } = await claimRunning(id);
    const uploaded = await uploadArtifact(agent, key, 'x\n', 'note.txt');
    expect(errorLines).toEqual([]);

    // 引用一个没上传过的 uri → 422，错误体里也不能带任何凭证。
    const bogus = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '引用不存在的产物',
      artifacts: [{ type: 'text', uri: 'artifacts/T-9999/R-1/deadbeef.txt', name: 'bogus.txt' }],
    });
    expect(bogus.status).toBe(422);
    expect(errorCode(bogus)).toBe('VALIDATION_FAILED');
    expect(bogus.text).not.toContain(agent.token);
    expect(bogus.text).not.toContain(t.uiToken);

    const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '正常回写',
      artifacts: [{ type: 'text', uri: uploaded.uri, name: 'note.txt' }],
    });
    expect(done.status).toBe(200);
    await approveDone(id);
    await ui.del(`${API}/tasks/${id}`);
    expect(existsSync(path.join(t.dir, 'artifacts', id))).toBe(false);

    const all = errorLines.join('\n');
    expect(all).not.toContain(agent.token);
    expect(all).not.toContain(t.uiToken);
    expect(all).not.toContain('Bearer');
  });
});

// ---------------------------------------------------------------- 局部夹具

interface Feedback {
  suggestion: string;
  reason: string;
  detail: string;
}

function fullFeedback(): Feedback {
  return {
    suggestion: '签名校验需覆盖空值',
    reason: '边界场景未处理',
    detail: '请补充 null 和空字符串的用例',
  };
}

/**
 * 建 → 待执行 → 认领 → 完成回写，停在待审核（`seed.toReview` 不返回租约，
 * 而验收 10 要按 run_id 对账审核意见，所以本地版本带上租约）。
 */
async function toReviewKey(id: string): Promise<Lease> {
  const { agent, key } = await claimRunning(id);
  const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
    ...key,
    summary: `${id} 已完成`,
    artifacts: [],
  });
  if (done.status !== 200) throw new Error(`完成回写失败：${done.status} ${done.text}`);
  return key;
}

async function approveDone(id: string): Promise<void> {
  const res = await ui.post(`${API}/tasks/${id}/review`, {
    conclusion: 'APPROVE',
    ...fullFeedback(),
  });
  if (res.status !== 201) throw new Error(`审核通过失败：${res.status} ${res.text}`);
}

/** 认领一条任务并让它停在执行中：产物上传要求 Run 属于该任务（20.6）。 */
async function claimRunning(id: string): Promise<{ agent: IssuedAgent; key: Lease }> {
  await clearReadyQueue(t);
  await ui.patch(`${API}/tasks/${id}`, { required_capabilities: [`tool:${id}`] });
  await toReady(t, id);
  const agent = await issueAgent(t, `worker-${agentSlug(id)}`, [`tool:${id}`]);
  const claimed = await claimOk(agent, id);
  return { agent, key: triple(claimed) };
}

/** Token 名称只吃小写字母、数字、`-`、`_`（13 章），任务号里的大写要先规范化。 */
function agentSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** 走真实 multipart 上传一个文本产物，返回 `{id, uri}`（uri 是相对数据目录的路径）。 */
async function uploadArtifact(
  agent: IssuedAgent,
  key: Lease,
  text: string,
  filename: string,
): Promise<{ id: string; uri: string; type: string }> {
  const form = new FormData();
  form.append('task_id', key.task_id);
  form.append('run_id', key.run_id);
  form.append('name', filename);
  form.append('file', new Blob([text], { type: 'text/plain' }), filename);
  const res = await agent.claims.send(`${API}/artifacts`, { method: 'POST', raw: form });
  if (res.status !== 201) throw new Error(`产物上传失败：${res.status} ${res.text}`);
  return res.body as { id: string; uri: string; type: string };
}

/** 执行记录列表里该任务的全部产物行（详情抽屉「执行记录」的数据源）。 */
async function runArtifacts(taskId: string): Promise<Record<string, unknown>[]> {
  const res = await ui.get(`${API}/tasks/${taskId}/runs`);
  expect(res.status).toBe(200);
  return (res.body.items as { artifacts: Record<string, unknown>[] }[]).flatMap(
    (run) => run.artifacts,
  );
}

function readArtifact(uri: string): string {
  return readFileSync(path.join(t.dir, uri), 'utf8');
}
