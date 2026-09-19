import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, errorMessage, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, anonSender } from '../../__tests__/helpers/seed';

/**
 * 0919 服务端市场对接层：连接/断开/状态、市场双源聚合、发布同步到服务端、订阅服务端技能落地、
 * 检查更新（服务端 versions 对比）、评分/评论/反馈代理、断电回落本地。
 *
 * 服务端用 node:http 起一次性假服务（真 fetch 走真 TCP，最贴近生产 undici 路径），
 * 契约与 apps/cloud 约定一致：/cloud/v1/accounts/*、/cloud/v1/market/*、JWT Bearer。
 */

const CLOUD_USER = 'clouduser';
const CLOUD_PASS = 'cloudpass';
const CLOUD_TOKEN = 'jwt_fake_cloud_token';

interface CloudListingRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  type: string;
  license: string;
  compatible_clients: string[];
  current_version: string;
  publisher_name: string;
  content: unknown;
  mcp_dependencies: unknown[];
  comments: { items: { id: string; account_id: string; author_name: string; content: string; created_at: string | null }[]; total: number };
  rating: { avg: number; count: number };
}

const state = {
  listings: [] as CloudListingRecord[],
  versions: { cl1: ['v1.0.0'] } as Record<string, string[]>,
  received: {
    publishes: [] as Record<string, unknown>[],
    ratings: [] as { id: string; score: number }[],
    comments: [] as { id: string; content: string }[],
    feedbacks: [] as { id: string; title: string; content: string }[],
    subscribes: [] as string[],
  },
};

function seedCloudState(): void {
  state.listings = [
    {
      id: 'cl1',
      slug: 'cloud-skill',
      name: '服务端技能',
      description: '来自服务端市场的技能',
      category: '效率',
      tags: ['cloud'],
      type: 'workflow',
      license: 'MIT',
      compatible_clients: ['claude-code'],
      current_version: 'v1.0.0',
      publisher_name: CLOUD_USER,
      content: {
        entryBlockId: 'c1',
        blocks: [{ id: 'c1', kind: 'prompt', title: '服务端步骤', prompt: '服务端提示词 v1' }],
      },
      mcp_dependencies: [],
      comments: {
        items: [
          { id: 'cc1', account_id: 'other', author_name: '路人甲', content: '不错', created_at: '2026-09-01T00:00:00.000Z' },
        ],
        total: 1,
      },
      rating: { avg: 4.5, count: 2 },
    },
  ];
  state.versions = { cl1: ['v1.0.0'] };
  state.received = { publishes: [], ratings: [], comments: [], feedbacks: [], subscribes: [] };
}

function requireAuth(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${CLOUD_TOKEN}`;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 一次性假服务端：路由按上述契约；token 错一律 401（带 error.message 原文）。 */
function startFakeCloud(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/cloud/v1/accounts/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.username === CLOUD_USER && body.password === CLOUD_PASS) {
        return json(res, 200, { token: CLOUD_TOKEN, username: CLOUD_USER });
      }
      return json(res, 401, { error: { code: 'UNAUTHORIZED', message: '用户名或密码错误' } });
    }
    if (!requireAuth(req)) {
      return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'token 无效' } });
    }
    const listingMatch = path.match(/^\/cloud\/v1\/market\/listings\/([^/]+)(\/.*)?$/);
    const id = listingMatch ? decodeURIComponent(listingMatch[1]!) : null;
    const sub = (suffix: string): boolean => Boolean(id && path.endsWith(suffix) && path.includes(id));

    if (path === '/cloud/v1/market/listings' && req.method === 'GET') {
      return json(res, 200, { items: state.listings });
    }
    if (path === '/cloud/v1/market/publish' && req.method === 'POST') {
      const body = await readBody(req);
      state.received.publishes.push(body);
      const created: CloudListingRecord = {
        id: `cl_${state.received.publishes.length + 10}`,
        slug: String(body.slug ?? 'skill'),
        name: String(body.name ?? ''),
        description: String(body.description ?? ''),
        category: String(body.category ?? ''),
        tags: (body.tags as string[]) ?? [],
        type: String(body.type ?? 'workflow'),
        license: String(body.license ?? ''),
        compatible_clients: (body.compatible_clients as string[]) ?? [],
        current_version: String(body.version ?? 'v0.1.0'),
        publisher_name: CLOUD_USER,
        content: body.content,
        mcp_dependencies: (body.mcp_dependencies as unknown[]) ?? [],
        comments: { items: [], total: 0 },
        rating: { avg: 0, count: 0 },
      };
      state.listings.push(created);
      return json(res, 201, { id: created.id, slug: created.slug });
    }
    if (id && !path.includes('/') === false && req.method === 'GET' && path.split('/').length === 6) {
      const found = state.listings.find((row) => row.id === id);
      if (!found) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'listing 不存在' } });
      return json(res, 200, found);
    }
    if (sub('/versions') && req.method === 'GET') {
      return json(res, 200, { items: (state.versions[id!] ?? []).map((version) => ({ version, published_at: null })) });
    }
    if (sub('/subscribe') && req.method === 'POST') {
      const found = state.listings.find((row) => row.id === id);
      if (!found) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'listing 不存在' } });
      state.received.subscribes.push(id!);
      return json(res, 200, {
        content: found.content,
        mcp_dependencies: found.mcp_dependencies,
        current_version: found.current_version,
      });
    }
    if (sub('/rating') && req.method === 'POST') {
      const body = await readBody(req);
      state.received.ratings.push({ id: id!, score: Number(body.score) });
      return json(res, 200, { avg: 4.8, count: 3 });
    }
    if (sub('/comments') && req.method === 'POST') {
      const body = await readBody(req);
      state.received.comments.push({ id: id!, content: String(body.content) });
      return json(res, 201, { id: `cc_${state.received.comments.length + 10}` });
    }
    if (sub('/feedback') && req.method === 'POST') {
      const body = await readBody(req);
      state.received.feedbacks.push({ id: id!, title: String(body.title), content: String(body.content) });
      return json(res, 201, { id: `cf_${state.received.feedbacks.length + 10}`, status: 'PENDING' });
    }
    if (sub('/favorite') && req.method === 'POST') {
      return json(res, 200, { favorited: true });
    }
    if (sub('/report') && req.method === 'POST') {
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: `未知路径 ${path}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let t: TestApp;
let admin: Sender;
let cloudServer: Server;
let cloudUrl: string;

async function login(username: string, password: string): Promise<Sender> {
  const res = await anonSender(t).post(`${API}/auth/login`, { username, password });
  expect(res.status).toBe(201);
  return (await import('../../__tests__/helpers/http-app')).request(t, res.body.token);
}

async function createPublishedSkill(sender: Sender, name: string, prompt = `${name} 的提示词`): Promise<string> {
  const created = await sender.post(`${API}/skills`, {
    name,
    type: 'workflow',
    description: `${name}描述`,
    tags: ['cloud-test'],
    content: {
      entryBlockId: 'b1',
      blocks: [{ id: 'b1', kind: 'prompt', title: '步骤一', prompt }],
    },
    mcp_dependencies: [],
  });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  const patched = await sender.patch(`${API}/skills/${id}`, { status: 'PUBLISHED' });
  expect(patched.status).toBe(200);
  return id;
}

async function connect(sender: Sender): Promise<void> {
  const res = await sender.post(`${API}/market/cloud/connect`, { url: cloudUrl, username: CLOUD_USER, password: CLOUD_PASS });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  seedCloudState();
  cloudServer = await startFakeCloud();
  const addr = cloudServer.address();
  if (!addr || typeof addr === 'string') throw new Error('假服务端监听失败');
  cloudUrl = `http://127.0.0.1:${addr.port}`;

  t = await createTestApp();
  const init = await anonSender(t).post(`${API}/auth/init`, {
    username: 'admin',
    password: 'secret66',
    display_name: '管理员',
  });
  expect(init.status).toBe(201);
  admin = await login('admin', 'secret66');
});

afterAll(async () => {
  if (t) await t.close();
  await new Promise<void>((resolve) => cloudServer.close(() => resolve()));
});

describe('服务端市场：连接管理', () => {
  it('status 未连接时 connected=false', async () => {
    const res = await admin.get(`${API}/market/cloud/status`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, url: '', username: '' });
  });

  it('connect 密码错误：502 且透传服务端原文，不落配置', async () => {
    const res = await admin.post(`${API}/market/cloud/connect`, {
      url: cloudUrl,
      username: CLOUD_USER,
      password: 'wrong',
    });
    expect(res.status).toBe(502);
    expect(errorCode(res)).toBe('CLOUD_ERROR');
    expect(errorMessage(res)).toContain('用户名或密码错误');
    const status = await admin.get(`${API}/market/cloud/status`);
    expect(status.body.connected).toBe(false);
  });

  it('connect 成功：服务端向服务端 login 校验并保存配置，status 回显 url/username', async () => {
    await connect(admin);
    const status = await admin.get(`${API}/market/cloud/status`);
    expect(status.body).toEqual({ connected: true, url: cloudUrl, username: CLOUD_USER });
    const settings = await admin.get(`${API}/settings`);
    expect(settings.body.cloud_enabled).toBe(true);
    expect(settings.body.cloud_url).toBe(cloudUrl);
    // token 由 login 换取落 settings（密码不落库）
    expect(settings.body.cloud_token).toBe(CLOUD_TOKEN);
  });

  it('disconnect：关开关清 token，url/username 保留回显', async () => {
    const res = await admin.post(`${API}/market/cloud/disconnect`, {});
    expect(res.status).toBe(201);
    expect(res.body.connected).toBe(false);
    const settings = await admin.get(`${API}/settings`);
    expect(settings.body.cloud_token).toBe('');
    expect(settings.body.cloud_url).toBe(cloudUrl);
    await connect(admin); // 后续用例继续在已连接状态下进行
  });
});

describe('服务端市场：双源浏览与详情', () => {
  it('已连接：listings 聚合服务端结果（source=cloud，publisher 为服务端用户名），本地 builtin 仍在', async () => {
    const res = await admin.get(`${API}/market/listings`);
    expect(res.status).toBe(200);
    const cloud = res.body.items.find((row: { source: string }) => row.source === 'cloud');
    expect(cloud).toBeTruthy();
    expect(cloud.id).toBe('cld_cl1');
    expect(cloud.name).toBe('服务端技能');
    expect(cloud.publisher_name).toBe(CLOUD_USER);
    expect(res.body.items.some((row: { source: string }) => row.source === 'builtin')).toBe(true);
    expect(res.body.warning).toBeUndefined();
  });

  it('服务端详情：content/评论/评分走服务端', async () => {
    const res = await admin.get(`${API}/market/listings/cld_cl1`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('cloud');
    expect(res.body.content.blocks[0].prompt).toBe('服务端提示词 v1');
    expect(res.body.comments.items).toHaveLength(1);
    expect(res.body.comments.items[0].author_name).toBe('路人甲');
    expect(res.body.rating).toEqual({ avg: 4.5, count: 2 });
    expect(res.body.my.subscribed).toBe(false);
  });

  it('服务端详情过滤：keyword 只匹配服务端/本地各自命中的条目', async () => {
    const res = await admin.get(`${API}/market/listings?keyword=服务端`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].source).toBe('cloud');
  });
});

describe('服务端市场：断电回落本地', () => {
  it('服务端不可达（假服务端宕机）：list 静默回落本地并带 warning，本地条目完整', async () => {
    await new Promise<void>((resolve) => cloudServer.close(() => resolve()));
    const res = await admin.get(`${API}/market/listings`);
    expect(res.status).toBe(200);
    expect(res.body.warning).toContain('服务端市场不可达');
    expect(res.body.items.every((row: { source: string }) => row.source !== 'cloud')).toBe(true);
    expect(res.body.items.some((row: { source: string }) => row.source === 'builtin')).toBe(true);
    // 重启假服务端继续后续用例
    cloudServer = await startFakeCloud();
    const addr = cloudServer.address();
    cloudUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
    await admin.post(`${API}/market/cloud/connect`, { url: cloudUrl, username: CLOUD_USER, password: CLOUD_PASS });
  });
});

describe('服务端市场：发布同步到服务端', () => {
  it('visibility=local：保持纯本地，不触碰服务端', async () => {
    const skillId = await createPublishedSkill(admin, '本地专属技能');
    const res = await admin.post(`${API}/market/cloud/publish`, {
      skill_id: skillId,
      category: '效率',
      license: 'MIT',
      compatible_clients: [],
      visibility: 'local',
    });
    expect(res.status).toBe(201);
    expect(res.body.published).toBe(false);
    expect(state.received.publishes).toHaveLength(0);
  });

  it('技能未发布：ILLEGAL_TRANSITION，不上传服务端', async () => {
    const created = await admin.post(`${API}/skills`, {
      name: '草稿技能',
      type: 'prompt',
      description: '',
      tags: [],
      content: { blocks: [{ id: 'b1', kind: 'prompt', title: 'x', prompt: 'x' }], entryBlockId: 'b1' },
      mcp_dependencies: [],
    });
    const res = await admin.post(`${API}/market/cloud/publish`, {
      skill_id: created.body.id,
      category: '效率',
      license: 'MIT',
      compatible_clients: [],
      visibility: 'public',
    });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ILLEGAL_TRANSITION');
    expect(state.received.publishes).toHaveLength(0);
  });

  it('发布同步到服务端成功：服务端收到技能快照，本地 listing 记 cloud_listing_id 且状态 PUBLISHED', async () => {
    const skillId = await createPublishedSkill(admin, '同步到服务端技能', '同步到服务端提示词');
    const res = await admin.post(`${API}/market/cloud/publish`, {
      skill_id: skillId,
      category: '测试',
      license: 'Apache-2.0',
      compatible_clients: ['qoder'],
      visibility: 'public',
    });
    expect(res.status).toBe(201);
    expect(state.received.publishes).toHaveLength(1);
    expect(state.received.publishes[0].name).toBe('同步到服务端技能');
    expect(state.received.publishes[0].version).toBe('v0.1.0');
    expect((state.received.publishes[0].content as { blocks: unknown[] }).blocks).toHaveLength(1);

    const listingId = res.body.id as string;
    expect(res.body.status).toBe('PUBLISHED');
    expect(res.body.cloud_listing_id).toBeTruthy();
    const row = await t.prisma.marketListing.findUnique({ where: { id: listingId } });
    const cloudId = state.listings.find((r) => r.name === '同步到服务端技能')!.id;
    expect(row?.cloudListingId).toBe(cloudId);
    expect(row?.status).toBe('PUBLISHED');
  });
});

describe('服务端市场：订阅与更新', () => {
  let subscribedSkillId: string | null = null;

  it('订阅服务端技能：服务端 content 落地为本地技能（source=market），快照版本来自服务端', async () => {
    const res = await admin.post(`${API}/market/listings/cld_cl1/subscribe`, {});
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('cloud');
    expect(res.body.snapshot_version).toBe('v1.0.0');
    expect(res.body.content.blocks[0].prompt).toBe('服务端提示词 v1');
    subscribedSkillId = res.body.skill_id;
    const skill = await t.prisma.skill.findUnique({ where: { id: subscribedSkillId! } });
    expect(skill?.source).toBe('market');
    expect(JSON.parse(skill?.content ?? '{}')).toEqual(state.listings[0].content);
    expect(state.received.subscribes).toContain('cl1');
  });

  it('服务端最新版本不变：pullUpdate 原样返回 SYNCED', async () => {
    const res = await admin.post(`${API}/market/listings/cld_cl1/update`, {});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SYNCED');
    expect(res.body.snapshot_version).toBe('v1.0.0');
  });

  it('服务端发新版本后检查更新：versions 对比命中，拉服务端快照升级本地技能', async () => {
    state.listings[0]!.current_version = 'v2.0.0';
    state.listings[0]!.content = {
      entryBlockId: 'c1',
      blocks: [{ id: 'c1', kind: 'prompt', title: '服务端步骤', prompt: '服务端提示词 v2' }],
    };
    state.versions.cl1 = ['v2.0.0', 'v1.0.0'];

    const res = await admin.post(`${API}/market/listings/cld_cl1/update`, {});
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SYNCED');
    expect(res.body.snapshot_version).toBe('v2.0.0');
    const skill = await t.prisma.skill.findUnique({ where: { id: subscribedSkillId! } });
    expect(skill?.currentVersion).toBe('v2.0.0');
    expect(JSON.parse(skill?.content ?? '{}').blocks[0].prompt).toBe('服务端提示词 v2');
    // 版本历史留痕
    const versions = await t.prisma.skillVersion.findMany({ where: { skillId: subscribedSkillId! } });
    expect(versions.map((row) => row.version).sort()).toEqual(['v1.0.0', 'v2.0.0']);
  });
});

describe('服务端市场：评分/评论/反馈代理（本地不落库）', () => {
  it('评分代理到服务端，本地 market_ratings 无记录', async () => {
    const res = await admin.post(`${API}/market/listings/cld_cl1/rating`, { score: 5 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ avg: 4.8, count: 3 });
    expect(state.received.ratings).toEqual([{ id: 'cl1', score: 5 }]);
    expect(await t.prisma.marketRating.count()).toBe(0);
  });

  it('评论代理到服务端并回显服务端结果', async () => {
    const res = await admin.post(`${API}/market/listings/cld_cl1/comments`, { content: '服务端评论' });
    expect(res.status).toBe(201);
    expect(res.body.author_name).toBe(CLOUD_USER);
    expect(state.received.comments).toEqual([{ id: 'cl1', content: '服务端评论' }]);
    expect(await t.prisma.marketComment.count()).toBe(0);
  });

  it('反馈代理到服务端', async () => {
    const res = await admin.post(`${API}/market/listings/cld_cl1/feedback`, {
      title: '服务端反馈',
      content: '希望支持导出',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING');
    expect(state.received.feedbacks).toEqual([{ id: 'cl1', title: '服务端反馈', content: '希望支持导出' }]);
    expect(await t.prisma.marketFeedback.count()).toBe(0);
  });

  it('未连接时服务端写操作报 CLOUD_ERROR', async () => {
    await admin.post(`${API}/market/cloud/disconnect`, {});
    const res = await admin.post(`${API}/market/listings/cld_cl1/rating`, { score: 4 });
    expect(res.status).toBe(502);
    expect(errorCode(res)).toBe('CLOUD_ERROR');
    await connect(admin);
  });
});
