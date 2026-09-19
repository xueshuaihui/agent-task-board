import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonSender, createTestApp, errorCode, request, type Sender, type TestApp } from './helpers/http-app';

const API = '/cloud/v1';

let t: TestApp;
let alice: Sender; // 发布者
let bob: Sender; // 订阅者/评论者
let carol: Sender; // 越权者
let aliceToken: string;
let listingId: string;

async function register(username: string, password = 'secret66', display_name?: string): Promise<Sender> {
  const res = await anonSender(t).post(`${API}/accounts/register`, { username, password, display_name });
  expect(res.status).toBe(201);
  const token = res.body.token as string;
  return request(t, token);
}

const CONTENT = (prompt: string) => ({
  entryBlockId: 'b1',
  blocks: [{ id: 'b1', kind: 'prompt', title: '步骤一', prompt }],
});

async function publish(name: string, slug?: string): Promise<{ res: any; id: string }> {
  const res = await alice.post(`${API}/market/publish`, {
    name,
    slug,
    description: `${name} 的描述`,
    category: '开发流程',
    tags: ['cloud-test'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: ['agent-task-board'],
    content: CONTENT(`${name} 提示词`),
    mcp_dependencies: [],
    version: '1.0.0',
  });
  return { res, id: res.body.id as string };
}

beforeAll(async () => {
  t = await createTestApp();
  alice = await register('alice', 'secret66', '爱丽丝');
  bob = await register('bob');
  carol = await register('carol');
  const login = await anonSender(t).post(`${API}/accounts/login`, { username: 'alice', password: 'secret66' });
  aliceToken = login.body.token as string;
  const published = await publish('代码评审', 'code-review');
  expect(published.res.status).toBe(201);
  listingId = published.id;
});

afterAll(async () => {
  if (t) await t.close();
});

// ---------------------------------------------------------------- 账号

describe('云账号', () => {
  it('注册：返回 token 与账号信息，/me 可取回', async () => {
    const me = await request(t, aliceToken).get(`${API}/accounts/me`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('alice');
    expect(me.body.display_name).toBe('爱丽丝');
    expect(me.body.id).toMatch(/^acct_/);
  });

  it('注册：重复用户名 409；用户名/密码不合法 422', async () => {
    const dup = await anonSender(t).post(`${API}/accounts/register`, { username: 'alice', password: 'secret66' });
    expect(dup.status).toBe(409);
    expect(errorCode(dup)).toBe('USERNAME_TAKEN');
    const bad = await anonSender(t).post(`${API}/accounts/register`, { username: 'x', password: '123' });
    expect(bad.status).toBe(422);
    expect(errorCode(bad)).toBe('VALIDATION_FAILED');
  });

  it('登录：正确密码发 token，错误密码 401', async () => {
    const ok = await anonSender(t).post(`${API}/accounts/login`, { username: 'alice', password: 'secret66' });
    expect(ok.status).toBe(201);
    expect(ok.body.token).toBeTruthy();
    const bad = await anonSender(t).post(`${API}/accounts/login`, { username: 'alice', password: 'wrong66' });
    expect(bad.status).toBe(401);
    expect(errorCode(bad)).toBe('UNAUTHORIZED');
  });

  it('鉴权失败：无 token / 假 token 访问受保护接口均 401', async () => {
    const none = await anonSender(t).get(`${API}/market/subscriptions`);
    expect(none.status).toBe(401);
    const fake = await request(t, 'not.a.jwt').get(`${API}/market/subscriptions`);
    expect(fake.status).toBe(401);
  });
});

// ---------------------------------------------------------------- 发布/浏览

describe('发布与浏览（匿名可浏览）', () => {
  it('发布：PUBLISHED 即上架，slug 取自名称 slugify 或显式指定', async () => {
    expect(listingId).toMatch(/^mkt_/);
    const anon = await anonSender(t).get(`${API}/market/listings/${listingId}`);
    expect(anon.status).toBe(200);
    expect(anon.body.status).toBe('PUBLISHED');
    expect(anon.body.publisher_name).toBe('爱丽丝');
    expect(anon.body.content.blocks[0].prompt).toContain('代码评审');
  });

  it('发布重名：slug 冲突自动加后缀', async () => {
    const a = await publish('重复技能', 'dup-skill');
    expect(a.res.status).toBe(201);
    expect(a.res.body.slug).toBe('dup-skill');
    const b = await publish('重复技能', 'dup-skill');
    expect(b.res.status).toBe(201);
    expect(b.res.body.slug).toBe('dup-skill-2');
    const c = await publish('重复技能', 'dup-skill');
    expect(c.res.body.slug).toBe('dup-skill-3');
  });

  it('浏览筛选：keyword / type / category 命中与不命中', async () => {
    const hit = await anonSender(t).get(`${API}/market/listings?keyword=评审`);
    expect(hit.status).toBe(200);
    expect(hit.body.items.some((x: any) => x.id === listingId)).toBe(true);
    const miss = await anonSender(t).get(`${API}/market/listings?keyword=不存在的关键词`);
    expect(miss.body.items).toHaveLength(0);
    const byType = await anonSender(t).get(`${API}/market/listings?type=prompt`);
    expect(byType.body.items.some((x: any) => x.id === listingId)).toBe(false);
    const byCat = await anonSender(t).get(`${API}/market/listings?category=${encodeURIComponent('开发流程')}`);
    expect(byCat.body.items.some((x: any) => x.id === listingId)).toBe(true);
  });

  it('排序：new 按 published_at 倒序；rating 按均分', async () => {
    await alice.post(`${API}/market/publish`, {
      name: '新技能',
      description: '较新',
      category: '写作',
      tags: [],
      type: 'prompt',
      license: '',
      compatible_clients: [],
      content: CONTENT('新'),
      mcp_dependencies: [],
      version: '0.1.0',
    });
    const news = await anonSender(t).get(`${API}/market/listings?sort=new`);
    // nowSql 秒级粒度，同秒发布可能并列；断言「新技能不晚于任何 listing 的发布时间」即可。
    const newest = news.body.items.reduce((acc: string, x: any) => (x.published_at > acc ? x.published_at : acc), '');
    const target = news.body.items.find((x: any) => x.name === '新技能');
    expect(target.published_at).toBe(newest);
    const rated = await anonSender(t).get(`${API}/market/listings?sort=rating`);
    const scores = rated.body.items.map((x: any) => x.rating_avg);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
  });

  it('入参校验：发布缺 type / 评分越界 422', async () => {
    const bad = await alice.post(`${API}/market/publish`, { name: 'x', description: 'y', category: 'z', version: '1' });
    expect(bad.status).toBe(422);
    const rate = await bob.post(`${API}/market/listings/${listingId}/rating`, { score: 9 });
    expect(rate.status).toBe(422);
  });
});

// ---------------------------------------------------------------- 订阅/版本/下线

describe('订阅快照与版本更新', () => {
  it('订阅：返回快照 content + version；重复订阅幂等', async () => {
    const sub = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(sub.status).toBe(201);
    expect(sub.body.status).toBe('SYNCED');
    expect(sub.body.snapshot_version).toBe('1.0.0');
    expect(sub.body.content.blocks[0].prompt).toContain('代码评审');
    const again = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(again.body.status).toBe('SYNCED');
    const list = await bob.get(`${API}/market/subscriptions`);
    expect(list.body.items).toHaveLength(1);
  });

  it('发新版本：仅发布者本人；订阅行置 HAS_UPDATE', async () => {
    const forbid = await carol.post(`${API}/market/listings/${listingId}/versions`, {
      content: CONTENT('越权'),
      version: '2.0.0',
      changelog: 'nope',
    });
    expect(forbid.status).toBe(403);
    const ok = await alice.post(`${API}/market/listings/${listingId}/versions`, {
      content: CONTENT('第二版提示词'),
      version: '2.0.0',
      changelog: '重写提示词',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.current_version).toBe('2.0.0');
    const list = await bob.get(`${API}/market/subscriptions`);
    expect(list.body.items[0].status).toBe('HAS_UPDATE');
    expect(list.body.items[0].latest_version).toBe('2.0.0');
  });

  it('拉新：POST /update 拿到新版快照，status 回 SYNCED', async () => {
    const upd = await bob.post(`${API}/market/listings/${listingId}/update`);
    expect(upd.status).toBe(201);
    expect(upd.body.snapshot_version).toBe('2.0.0');
    expect(upd.body.content.blocks[0].prompt).toContain('第二版');
    expect(upd.body.status).toBe('SYNCED');
  });

  it('取消订阅：DELETE 后不在我的订阅里，未订阅时 404', async () => {
    const del = await bob.del(`${API}/market/listings/${listingId}/subscribe`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const upd = await bob.post(`${API}/market/listings/${listingId}/update`);
    expect(upd.status).toBe(404);
  });

  it('下线：仅发布者本人；订阅行置 DELISTED；匿名详情 404、不可再订阅', async () => {
    const sub = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(sub.status).toBe(201);
    const forbid = await carol.post(`${API}/market/listings/${listingId}/delist`);
    expect(forbid.status).toBe(403);
    const ok = await alice.post(`${API}/market/listings/${listingId}/delist`);
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('DELISTED');
    const anon = await anonSender(t).get(`${API}/market/listings/${listingId}`);
    expect(anon.status).toBe(404);
    const browse = await anonSender(t).get(`${API}/market/listings`);
    expect(browse.body.items.some((x: any) => x.id === listingId)).toBe(false);
    const resub = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(resub.status).toBe(409);
    const list = await bob.get(`${API}/market/subscriptions`);
    expect(list.body.items[0].listing_status).toBe('DELISTED');
    const again = await alice.post(`${API}/market/listings/${listingId}/delist`);
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------- 评分/评论/收藏/举报/反馈

describe('评分/评论/收藏/举报/反馈闭环', () => {
  let freshId: string;

  beforeAll(async () => {
    const pub = await publish('反馈示例');
    expect(pub.res.status).toBe(201);
    freshId = pub.id;
  });

  it('评分：1-5 记录并聚合 avg/count；重复评分覆盖', async () => {
    const a = await bob.post(`${API}/market/listings/${freshId}/rating`, { score: 5 });
    expect(a.status).toBe(201);
    expect(a.body).toEqual({ avg: 5, count: 1 });
    const b = await carol.post(`${API}/market/listings/${freshId}/rating`, { score: 3 });
    expect(b.body).toEqual({ avg: 4, count: 2 });
    const again = await carol.post(`${API}/market/listings/${freshId}/rating`, { score: 4 });
    expect(again.body).toEqual({ avg: 4.5, count: 2 });
    const detail = await bob.get(`${API}/market/listings/${freshId}`);
    expect(detail.body.rating).toEqual({ avg: 4.5, count: 2 });
  });

  it('评论：登录可发、匿名不可发；删除仅作者本人或 ADMIN', async () => {
    const created = await bob.post(`${API}/market/listings/${freshId}/comments`, { content: '很好用' });
    expect(created.status).toBe(201);
    const commentId = created.body.id as string;
    const anon = await anonSender(t).get(`${API}/market/listings/${freshId}`);
    expect(anon.body.comments.items.map((x: any) => x.content)).toContain('很好用');
    const noAuth = await anonSender(t).post(`${API}/market/listings/${freshId}/comments`, { content: 'x' });
    expect(noAuth.status).toBe(401);
    const forbid = await carol.del(`${API}/market/comments/${commentId}`);
    expect(forbid.status).toBe(403);
    const ok = await bob.del(`${API}/market/comments/${commentId}`);
    expect(ok.status).toBe(200);
    const missing = await bob.del(`${API}/market/comments/mkc_none`);
    expect(missing.status).toBe(404);
  });

  it('收藏：toggle 两次回到未收藏；我的收藏同步', async () => {
    const on = await bob.post(`${API}/market/listings/${freshId}/favorite`);
    expect(on.body).toEqual({ favorited: true });
    const mine = await bob.get(`${API}/market/me/favorites`);
    expect(mine.body.items.map((x: any) => x.id)).toContain(freshId);
    const off = await bob.post(`${API}/market/listings/${freshId}/favorite`);
    expect(off.body).toEqual({ favorited: false });
  });

  it('举报：登录即可提交', async () => {
    const res = await carol.post(`${API}/market/listings/${freshId}/report`, { reason: '内容不实' });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it('反馈闭环：提交 → 非作者响应 403 → 作者 fixed → 提交者确认 RESOLVED', async () => {
    const created = await bob.post(`${API}/market/listings/${freshId}/feedback`, {
      title: '示例缺一步',
      content: '第二步之后没有输出说明',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING');
    const feedbackId = created.body.id as string;

    const forbid = await carol.post(`${API}/market/feedbacks/${feedbackId}/respond`, {
      response: '不是作者',
      resolution: 'fixed',
    });
    expect(forbid.status).toBe(403);

    const responded = await alice.post(`${API}/market/feedbacks/${feedbackId}/respond`, {
      response: '已在 2.0.0 补充',
      resolution: 'fixed',
    });
    expect(responded.status).toBe(201);
    expect(responded.body.status).toBe('FIXED_PENDING_VERIFY');
    expect(responded.body.author_response).toContain('2.0.0');

    const verifyNotOwner = await carol.post(`${API}/market/feedbacks/${feedbackId}/verify`, { confirmed: true });
    expect(verifyNotOwner.status).toBe(403);
    const rejected = await bob.post(`${API}/market/feedbacks/${feedbackId}/verify`, { confirmed: false });
    expect(rejected.body.status).toBe('PENDING');
    await alice.post(`${API}/market/feedbacks/${feedbackId}/respond`, { response: '再修一版', resolution: 'fixed' });
    const confirmed = await bob.post(`${API}/market/feedbacks/${feedbackId}/verify`, { confirmed: true });
    expect(confirmed.body.status).toBe('RESOLVED');
    const closed = await alice.post(`${API}/market/feedbacks/${feedbackId}/respond`, {
      response: '重复响应',
      resolution: 'wontfix',
    });
    expect(closed.status).toBe(409);
    const mine = await bob.get(`${API}/market/me/feedbacks`);
    expect(mine.body.items.map((x: any) => x.id)).toContain(feedbackId);
  });
});
