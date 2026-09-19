import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, anonSender } from '../../__tests__/helpers/seed';

/**
 * 0919 九章云端市场：内置种子、浏览/排序/筛选、发布-审核流、订阅与快照落地、
 * 更新拉新、下线保留快照（9.4）、评分/评论/收藏/举报、反馈闭环、权限边界。
 */

async function login(app: TestApp, username: string, password: string): Promise<Sender> {
  const res = await anonSender(app).post(`${API}/auth/login`, { username, password });
  if (res.status !== 201) throw new Error(`登录失败 ${username}：${res.status} ${res.text}`);
  return (await import('../../__tests__/helpers/http-app')).request(app, res.body.token);
}

let t: TestApp;
let admin: Sender;
let alice: Sender; // 发布者
let bob: Sender; // 订阅者/评论者
let carol: Sender; // 越权者

async function createPublishedSkill(sender: Sender, name: string, description = `${name}描述`): Promise<string> {
  const created = await sender.post(`${API}/skills`, {
    name,
    type: 'workflow',
    description,
    tags: ['market-test'],
    content: {
      entryBlockId: 'b1',
      blocks: [{ id: 'b1', kind: 'prompt', title: '步骤一', prompt: `${name} 的提示词` }],
    },
    mcp_dependencies: [],
  });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const patched = await sender.patch(`${API}/skills/${id}`, { status: 'PUBLISHED' });
  expect(patched.status).toBe(200);
  return id;
}

async function makeSkillVersion(sender: Sender, skillId: string, prompt: string): Promise<string> {
  const res = await sender.post(`${API}/skills/${skillId}/versions`, {
    content: {
      entryBlockId: 'b1',
      blocks: [{ id: 'b1', kind: 'prompt', title: 'v2', prompt }],
    },
    changelog: '第二版',
  });
  expect(res.status).toBe(201);
  return res.body.current_version as string;
}

beforeAll(async () => {
  t = await createTestApp();
  const init = await anonSender(t).post(`${API}/auth/init`, {
    username: 'admin',
    password: 'secret66',
    display_name: '管理员',
  });
  expect(init.status).toBe(201);
  admin = await login(t, 'admin', 'secret66');
  for (const name of ['alice', 'bob', 'carol']) {
    const created = await admin.post(`${API}/auth/users`, { username: name, password: 'first66' });
    expect(created.status).toBe(201);
    const first = await anonSender(t).post(`${API}/auth/login`, { username: name, password: 'first66' });
    const member = (await import('../../__tests__/helpers/http-app')).request(t, first.body.token);
    await member.post(`${API}/auth/change-password`, { current_password: 'first66', new_password: 'second77' });
  }
  alice = await login(t, 'alice', 'second77');
  bob = await login(t, 'bob', 'second77');
  carol = await login(t, 'carol', 'second77');
});

afterAll(async () => {
  if (t) await t.close();
});

describe('市场：内置技能与浏览', () => {
  it('启动种子：50 个内置技能全部 PUBLISHED，publisher 显示「官方」', async () => {
    const res = await bob.get(`${API}/market/listings`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(50);
    const builtins = res.body.items.filter((row: any) => row.source === 'builtin');
    expect(builtins.length).toBe(50);
    for (const row of builtins) {
      expect(row.status).toBe('PUBLISHED');
      expect(row.publisher_name).toBe('官方');
      expect(row.content === undefined).toBe(true); // 列表不带 content
    }
    const slugs = builtins.map((row: any) => row.slug);
    for (const slug of [
      'code-review',
      'bug-fix',
      'unit-testing',
      'performance-optimization',
      'security-scan',
      'deployment-pipeline',
      'commit-message',
      'readme-generation',
      'refactoring-advice',
      'regex-explain',
      'sql-optimization',
      'api-design-review',
      'code-explain',
      'doc-translation',
      'weekly-report',
      'pr-description',
      'coverage-gap-analysis',
      'incident-postmortem',
      'log-analysis',
    ]) {
      expect(slugs).toContain(slug);
    }
  });

  it('浏览筛选：keyword/category/type/min_rating/compatible_client', async () => {
    const kw = await bob.get(`${API}/market/listings?keyword=${encodeURIComponent('审查')}`);
    expect(kw.body.items.some((row: any) => row.slug === 'code-review')).toBe(true);

    const cat = await bob.get(`${API}/market/listings?category=${encodeURIComponent('测试')}`);
    expect(cat.body.items.length).toBeGreaterThan(0);
    expect(cat.body.items.every((row: any) => row.category === '测试')).toBe(true);

    const type = await bob.get(`${API}/market/listings?type=steps`);
    expect(type.body.items.every((row: any) => row.type === 'steps')).toBe(true);

    const client = await bob.get(
      `${API}/market/listings?compatible_client=${encodeURIComponent('Claude Code')}`,
    );
    expect(client.body.items.length).toBe(50);

    const none = await bob.get(
      `${API}/market/listings?compatible_client=${encodeURIComponent('不存在的客户端')}`,
    );
    expect(none.body.total).toBe(0);

    // min_rating：先没人评分，0 条
    const rated = await bob.get(`${API}/market/listings?min_rating=4.5`);
    expect(rated.body.total).toBe(0);
  });

  it('UNLISTED 不进浏览；detail 非发布者 404，发布者可见', async () => {
    const skillId = await createPublishedSkill(alice, '内部规范');
    const pub = await alice.post(`${API}/market/publish`, {
      skill_id: skillId,
      visibility: 'private',
      category: '开发流程',
    });
    expect(pub.status).toBe(201);
    expect(pub.body.status).toBe('UNLISTED');
    expect(pub.body.status_label).toBe('未发布');
    const listingId = pub.body.id as string;

    const browse = await carol.get(`${API}/market/listings`);
    expect(browse.body.items.some((row: any) => row.id === listingId)).toBe(false);

    expect((await carol.get(`${API}/market/listings/${listingId}`)).status).toBe(404);
    const mine = await alice.get(`${API}/market/listings/${listingId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.my.subscribed).toBe(false);

    // 我的发布里可见
    const publishes = await alice.get(`${API}/market/me/publishes`);
    const row = publishes.body.items.find((item: any) => item.id === listingId);
    expect(row.status_label).toBe('未发布');
  });

  it('排序：hot 按订阅数、rating 按评分、new 按上架时间', async () => {
    const skillA = await createPublishedSkill(alice, '排序甲');
    const a = await alice.post(`${API}/market/publish`, { skill_id: skillA, visibility: 'public', category: '开发流程' });
    const skillB = await createPublishedSkill(alice, '排序乙');
    const b = await alice.post(`${API}/market/publish`, { skill_id: skillB, visibility: 'public', category: '开发流程' });
    await admin.post(`${API}/market/listings/${a.body.id}/review`, { action: 'approve' });
    await admin.post(`${API}/market/listings/${b.body.id}/review`, { action: 'approve' });

    await bob.post(`${API}/market/listings/${a.body.id}/subscribe`);
    await bob.post(`${API}/market/listings/${a.body.id}/rating`, { score: 5 });
    await bob.post(`${API}/market/listings/${b.body.id}/rating`, { score: 3 });

    const hot = await bob.get(`${API}/market/listings?sort=hot`);
    expect(hot.body.items[0].id).toBe(a.body.id);
    const rating = await bob.get(`${API}/market/listings?sort=rating`);
    expect(rating.body.items[0].id).toBe(a.body.id);
    expect(rating.body.items[0].rating_avg).toBe(5);
    const fresh = await bob.get(`${API}/market/listings?sort=new`);
    // published_at 秒级精度，同秒内不比先后：断言整体按上架时间降序
    for (let i = 1; i < fresh.body.items.length; i += 1) {
      expect((fresh.body.items[i - 1].published_at ?? '') >= (fresh.body.items[i].published_at ?? '')).toBe(true);
    }
    expect(fresh.body.items.some((row: any) => row.id === b.body.id)).toBe(true);
    const downloads = await bob.get(`${API}/market/listings?sort=downloads`);
    expect(downloads.body.items[0].id).toBe(a.body.id);
  });
});

describe('市场：发布与审核（9.3）', () => {
  it('技能非 PUBLISHED 状态不能发布（409）', async () => {
    const created = await alice.post(`${API}/skills`, {
      name: '草稿技能',
      type: 'prompt',
      description: '',
      tags: [],
      content: { blocks: [], entryBlockId: null },
      mcp_dependencies: [],
    });
    const res = await alice.post(`${API}/market/publish`, {
      skill_id: created.body.id,
      visibility: 'public',
      category: '开发流程',
    });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ILLEGAL_TRANSITION');
  });

  it('公开发布 → PENDING_REVIEW（审核中）；非 ADMIN 审核 403；拒绝与通过', async () => {
    const skillId = await createPublishedSkill(alice, '公开工具');
    const pub = await alice.post(`${API}/market/publish`, {
      skill_id: skillId,
      visibility: 'public',
      category: '开发流程',
      license: 'MIT',
      compatible_clients: ['Claude Code'],
    });
    expect(pub.status).toBe(201);
    expect(pub.body.status).toBe('PENDING_REVIEW');
    expect(pub.body.status_label).toBe('审核中');
    expect(pub.body.publisher_name).toBe('alice');
    expect(pub.body.content.blocks.length).toBe(1); // 快照即技能当前内容
    const listingId = pub.body.id as string;

    const browse = await carol.get(`${API}/market/listings`);
    expect(browse.body.items.some((row: any) => row.id === listingId)).toBe(false);

    const forbidden = await alice.post(`${API}/market/listings/${listingId}/review`, { action: 'approve' });
    expect(forbidden.status).toBe(403);
    expect(errorCode(forbidden)).toBe('FORBIDDEN');

    // 拒绝：带 reason
    const rejected = await admin.post(`${API}/market/listings/${listingId}/review`, {
      action: 'reject',
      reason: '内容不符合上架规范',
    });
    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.review_note).toBe('内容不符合上架规范');

    // 重新走一遍公开发布并 approve → PUBLISHED + published_at + 进浏览
    const pub2 = await alice.post(`${API}/market/publish`, {
      skill_id: skillId,
      visibility: 'public',
      category: '开发流程',
    });
    const approved = await admin.post(`${API}/market/listings/${pub2.body.id}/review`, { action: 'approve' });
    expect(approved.status).toBe(201);
    expect(approved.body.status).toBe('PUBLISHED');
    expect(approved.body.published_at).toBeTypeOf('string');
    const browse2 = await carol.get(`${API}/market/listings`);
    expect(browse2.body.items.some((row: any) => row.id === pub2.body.id)).toBe(true);
  });

  it('slug 冲突自动加后缀', async () => {
    const s1 = await createPublishedSkill(alice, 'dup-skill');
    const p1 = await alice.post(`${API}/market/publish`, { skill_id: s1, visibility: 'public', category: '开发流程' });
    const s2 = await createPublishedSkill(bob, 'dup skill');
    const p2 = await bob.post(`${API}/market/publish`, { skill_id: s2, visibility: 'public', category: '开发流程' });
    expect(p1.body.slug).toBe('dup-skill');
    expect(p2.body.slug).toBe('dup-skill-2');
  });
});

describe('市场：订阅与快照落地（9.4/10.1）', () => {
  let listingId: string;
  let skillId: string;

  beforeAll(async () => {
    skillId = await createPublishedSkill(alice, '订阅目标', '订阅目标技能');
    const pub = await alice.post(`${API}/market/publish`, {
      skill_id: skillId,
      visibility: 'public',
      category: '开发流程',
    });
    await admin.post(`${API}/market/listings/${pub.body.id}/review`, { action: 'approve' });
    listingId = pub.body.id;
  });

  it('订阅：返回本地技能 id，本账号落地 source=market 的技能，内容与快照一致，计数 +1', async () => {
    const res = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(res.status).toBe(201);
    const localSkillId = res.body.skill_id as string;
    expect(localSkillId).toBeTypeOf('string');
    expect(res.body.status).toBe('SYNCED');
    expect(res.body.snapshot_version).toBe('v0.1.0');
    expect(res.body.content.blocks.length).toBe(1);

    const local = await bob.get(`${API}/skills/${localSkillId}`);
    expect(local.status).toBe(200);
    // skills DTO 不出 source（skills 模块未动），直接验库里的 source 标记
    const localRow = await t.prisma.skill.findUnique({ where: { id: localSkillId } });
    expect(localRow?.source).toBe('market');
    expect(local.body.content.blocks[0].prompt).toBe('订阅目标 的提示词');
    expect(local.body.current_version).toBe('v0.1.0');

    const detail = await bob.get(`${API}/market/listings/${listingId}`);
    expect(detail.body.my.subscribed).toBe(true);
    expect(detail.body.subscriber_count).toBe(1);
  });

  it('重复订阅不重复落地技能，计数不变', async () => {
    const again = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(again.status).toBe(201);
    const detail = await bob.get(`${API}/market/listings/${listingId}`);
    expect(detail.body.subscriber_count).toBe(1);
    const locals = await bob.get(`${API}/skills?keyword=${encodeURIComponent('订阅目标')}`);
    expect(locals.body.items.length).toBe(1);
  });

  it('本地重名技能加后缀', async () => {
    // alice 与 carol 各发布一个同名技能；carol 先订 alice 的（落地「重名目标」），再订自己的 → (2)
    const sA = await createPublishedSkill(alice, '重名目标');
    const sB = await createPublishedSkill(carol, '重名目标');
    const pA = await alice.post(`${API}/market/publish`, { skill_id: sA, visibility: 'public', category: '开发流程' });
    const pB = await carol.post(`${API}/market/publish`, { skill_id: sB, visibility: 'public', category: '开发流程' });
    // 中文名 slugify 归一为 'skill'，同库唯一靠后缀区分
    expect(pA.body.slug).toMatch(/^skill(-\d+)?$/);
    expect(pB.body.slug).not.toBe(pA.body.slug);
    await admin.post(`${API}/market/listings/${pA.body.id}/review`, { action: 'approve' });
    await admin.post(`${API}/market/listings/${pB.body.id}/review`, { action: 'approve' });
    const first = await carol.post(`${API}/market/listings/${pA.body.id}/subscribe`);
    const firstLocal = await carol.get(`${API}/skills/${first.body.skill_id}`);
    // carol 自己已有技能「重名目标」，订阅落地的第一个排到 (2)
    expect(firstLocal.body.name).toBe('重名目标 (2)');
    const sub = await carol.post(`${API}/market/listings/${pB.body.id}/subscribe`);
    expect(sub.status).toBe(201);
    const local = await carol.get(`${API}/skills/${sub.body.skill_id}`);
    expect(local.body.name).toBe('重名目标 (3)');
  });

  it('发布者发新版本 → 订阅行 HAS_UPDATE；update 拉新：快照升级 + 本地技能新增版本', async () => {
    const newVersion = await makeSkillVersion(alice, skillId, '订阅目标第二版提示词');
    expect(newVersion).toBe('v0.1.1');
    const pv = await alice.post(`${API}/market/listings/${listingId}/publish-version`, { skill_id: skillId });
    expect(pv.status).toBe(201);
    expect(pv.body.current_version).toBe('v0.1.1');

    const subs = await bob.get(`${API}/market/subscriptions`);
    const row = subs.body.items.find((item: any) => item.listing_id === listingId);
    expect(row.status).toBe('HAS_UPDATE');
    expect(row.snapshot_version).toBe('v0.1.0');
    expect(row.latest_version).toBe('v0.1.1');

    const updated = await bob.post(`${API}/market/listings/${listingId}/update`);
    expect(updated.status).toBe(201);
    expect(updated.body.status).toBe('SYNCED');
    expect(updated.body.snapshot_version).toBe('v0.1.1');

    const local = await bob.get(`${API}/skills/${row.skill_id}`);
    expect(local.body.current_version).toBe('v0.1.1');
    expect(local.body.content.blocks[0].prompt).toBe('订阅目标第二版提示词');
    expect(local.body.versions.some((v: any) => v.version === 'v0.1.1')).toBe(true);
  });

  it('取消订阅：订阅行删除、本地技能保留、计数回落', async () => {
    const skillLocal = await createPublishedSkill(alice, '退订目标');
    const pub = await alice.post(`${API}/market/publish`, { skill_id: skillLocal, visibility: 'public', category: '开发流程' });
    await admin.post(`${API}/market/listings/${pub.body.id}/review`, { action: 'approve' });
    const sub = await carol.post(`${API}/market/listings/${pub.body.id}/subscribe`);
    const localSkillId = sub.body.skill_id as string;

    const bye = await carol.del(`${API}/market/listings/${pub.body.id}/subscribe`);
    expect(bye.status).toBe(200);
    const subs = await carol.get(`${API}/market/subscriptions`);
    expect(subs.body.items.some((item: any) => item.listing_id === pub.body.id)).toBe(false);
    expect((await carol.get(`${API}/skills/${localSkillId}`)).status).toBe(200); // 本地技能保留
    const detail = await carol.get(`${API}/market/listings/${pub.body.id}`);
    expect(detail.body.subscriber_count).toBe(0);
    expect(detail.body.my.subscribed).toBe(false);
  });

  it('GET /market/subscriptions 含 listing 摘要、status 与本地 skill_id', async () => {
    const subs = await bob.get(`${API}/market/subscriptions`);
    expect(subs.body.total).toBeGreaterThan(0);
    const row = subs.body.items[0];
    expect(row.listing_name).toBeTypeOf('string');
    expect(row.skill_id).toBeTypeOf('string');
    expect(['SYNCED', 'HAS_UPDATE', 'DELISTED']).toContain(row.status);
  });
});

describe('市场：下线保留快照（9.4）', () => {
  it('非 publisher 非 ADMIN 下线 403；下线后不出浏览、订阅行 DELISTED、本地技能与快照保留', async () => {
    const skillId = await createPublishedSkill(alice, '下线目标');
    const pub = await alice.post(`${API}/market/publish`, { skill_id: skillId, visibility: 'public', category: '开发流程' });
    await admin.post(`${API}/market/listings/${pub.body.id}/review`, { action: 'approve' });
    const listingId = pub.body.id;

    const sub = await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    const localSkillId = sub.body.skill_id as string;
    const before = await bob.get(`${API}/market/subscriptions`);
    const beforeSnapshot = before.body.items.find((item: any) => item.listing_id === listingId).snapshot_version;

    const forbidden = await carol.post(`${API}/market/listings/${listingId}/delist`);
    expect(forbidden.status).toBe(403);
    expect(errorCode(forbidden)).toBe('FORBIDDEN');

    const delisted = await alice.post(`${API}/market/listings/${listingId}/delist`);
    expect(delisted.status).toBe(201);
    expect(delisted.body.status).toBe('DELISTED');
    expect(delisted.body.status_label).toBe('已下线');

    const browse = await carol.get(`${API}/market/listings`);
    expect(browse.body.items.some((row: any) => row.id === listingId)).toBe(false);

    const subs = await bob.get(`${API}/market/subscriptions`);
    const row = subs.body.items.find((item: any) => item.listing_id === listingId);
    expect(row.status).toBe('DELISTED');
    expect(row.snapshot_version).toBe(beforeSnapshot); // 快照保留
    expect((await bob.get(`${API}/skills/${localSkillId}`)).status).toBe(200); // 本地技能保留可执行

    // 下线后不可再订阅
    const resub = await carol.post(`${API}/market/listings/${listingId}/subscribe`);
    expect(resub.status).toBe(409);
  });
});

describe('市场：评分/评论/收藏/举报（9.5）', () => {
  let listingId: string;

  beforeAll(async () => {
    const skillId = await createPublishedSkill(alice, '互动目标');
    const pub = await alice.post(`${API}/market/publish`, { skill_id: skillId, visibility: 'public', category: '开发流程' });
    await admin.post(`${API}/market/listings/${pub.body.id}/review`, { action: 'approve' });
    listingId = pub.body.id;
  });

  it('评分：两人评分汇总；修改评分重新汇总', async () => {
    expect((await bob.post(`${API}/market/listings/${listingId}/rating`, { score: 5 })).status).toBe(201);
    expect((await carol.post(`${API}/market/listings/${listingId}/rating`, { score: 4 })).status).toBe(201);
    let detail = await bob.get(`${API}/market/listings/${listingId}`);
    expect(detail.body.rating).toEqual({ avg: 4.5, count: 2 });
    expect(detail.body.my.rating).toBe(5);

    expect((await bob.post(`${API}/market/listings/${listingId}/rating`, { score: 3 })).status).toBe(201);
    detail = await bob.get(`${API}/market/listings/${listingId}`);
    expect(detail.body.rating).toEqual({ avg: 3.5, count: 2 });

    const bad = await bob.post(`${API}/market/listings/${listingId}/rating`, { score: 6 });
    expect(bad.status).toBe(422);
  });

  it('评论：添加带作者名；≤500 字校验；本人删除，他人 403，ADMIN 可删', async () => {
    const added = await bob.post(`${API}/market/listings/${listingId}/comments`, { content: '审查很全面，推荐使用' });
    expect(added.status).toBe(201);
    const commentId = added.body.id as string;
    expect(added.body.author_name).toBe('bob');

    const tooLong = await bob.post(`${API}/market/listings/${listingId}/comments`, { content: 'x'.repeat(501) });
    expect(tooLong.status).toBe(422);

    const otherDelete = await carol.del(`${API}/market/comments/${commentId}`);
    expect(otherDelete.status).toBe(403);

    const c2 = await carol.post(`${API}/market/listings/${listingId}/comments`, { content: '有帮助' });
    expect((await admin.del(`${API}/market/comments/${c2.body.id}`)).status).toBe(200);
    expect((await bob.del(`${API}/market/comments/${commentId}`)).status).toBe(200);
    const detail = await bob.get(`${API}/market/listings/${listingId}`);
    expect(detail.body.comments.total).toBe(0);
  });

  it('收藏 toggle + 我的收藏；举报成功', async () => {
    const on = await bob.post(`${API}/market/listings/${listingId}/favorite`);
    expect(on.body.favorited).toBe(true);
    const favorites = await bob.get(`${API}/market/me/favorites`);
    expect(favorites.body.items.some((row: any) => row.id === listingId)).toBe(true);
    const off = await bob.post(`${API}/market/listings/${listingId}/favorite`);
    expect(off.body.favorited).toBe(false);
    const after = await bob.get(`${API}/market/me/favorites`);
    expect(after.body.items.some((row: any) => row.id === listingId)).toBe(false);

    const report = await bob.post(`${API}/market/listings/${listingId}/report`, { reason: '执行结果可疑' });
    expect(report.status).toBe(201);
  });

  it('详情 my 汇总：subscribed/favorited/rating', async () => {
    await bob.post(`${API}/market/listings/${listingId}/subscribe`);
    await bob.post(`${API}/market/listings/${listingId}/favorite`);
    await bob.post(`${API}/market/listings/${listingId}/rating`, { score: 4 });
    const detail = await bob.get(`${API}/market/listings/${listingId}`);
    expect(detail.body.my).toEqual({ subscribed: true, favorited: true, rating: 4 });
  });
});

describe('市场：反馈闭环（9.5/14.3）', () => {
  let listingId: string;
  let feedbackId: string;

  beforeAll(async () => {
    const skillId = await createPublishedSkill(alice, '反馈目标');
    const pub = await alice.post(`${API}/market/publish`, { skill_id: skillId, visibility: 'public', category: '开发流程' });
    await admin.post(`${API}/market/listings/${pub.body.id}/review`, { action: 'approve' });
    listingId = pub.body.id;
    const fb = await bob.post(`${API}/market/listings/${listingId}/feedback`, {
      title: '变量未定义',
      content: '执行时报 ReferenceError',
    });
    expect(fb.status).toBe(201);
    expect(fb.body.status).toBe('PENDING');
    feedbackId = fb.body.id as string;
  });

  it('非 publisher 不能 respond；publisher 响应 fixed → FIXED_PENDING_VERIFY', async () => {
    const forbidden = await carol.post(`${API}/market/feedbacks/${feedbackId}/respond`, {
      response: '我也遇到了',
      resolution: 'fixed',
    });
    expect(forbidden.status).toBe(403);

    const responded = await alice.post(`${API}/market/feedbacks/${feedbackId}/respond`, {
      response: '已在 v1.0.1 修复',
      resolution: 'fixed',
    });
    expect(responded.status).toBe(201);
    expect(responded.body.status).toBe('FIXED_PENDING_VERIFY');
    expect(responded.body.author_response).toBe('已在 v1.0.1 修复');
    expect(responded.body.responded_at).toBeTypeOf('string');
  });

  it('非提交者不能 verify；提交者确认 → RESOLVED，否定 → 回 PENDING', async () => {
    const forbidden = await carol.post(`${API}/market/feedbacks/${feedbackId}/verify`, { confirmed: true });
    expect(forbidden.status).toBe(403);

    const denied = await bob.post(`${API}/market/feedbacks/${feedbackId}/verify`, { confirmed: false });
    expect(denied.status).toBe(201);
    expect(denied.body.status).toBe('PENDING');

    await alice.post(`${API}/market/feedbacks/${feedbackId}/respond`, { response: '再次修复', resolution: 'fixed' });
    const confirmed = await bob.post(`${API}/market/feedbacks/${feedbackId}/verify`, { confirmed: true });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.status).toBe('RESOLVED');

    // 已闭环不可再响应
    const again = await alice.post(`${API}/market/feedbacks/${feedbackId}/respond`, {
      response: 'x',
      resolution: 'fixed',
    });
    expect(again.status).toBe(409);
  });

  it('wontfix 路径 + 我的反馈列表', async () => {
    const fb = await bob.post(`${API}/market/listings/${listingId}/feedback`, {
      title: '希望支持导出',
      content: '建议支持 .atskill 导出',
    });
    const wont = await alice.post(`${API}/market/feedbacks/${fb.body.id}/respond`, {
      response: '暂不支持，后续评估',
      resolution: 'wontfix',
    });
    expect(wont.status).toBe(201);
    expect(wont.body.status).toBe('WONTFIX');

    const mine = await bob.get(`${API}/market/me/feedbacks`);
    expect(mine.body.total).toBe(2);
    const row = mine.body.items.find((item: any) => item.id === feedbackId);
    expect(row.listing_name).toBe('反馈目标');
    expect(row.status).toBe('RESOLVED');
    expect(row.author_response).toBe('再次修复');
  });
});
