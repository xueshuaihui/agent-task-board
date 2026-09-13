import { Prisma, PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CustomFieldFilter } from '../../contract/schemas';
import { jsonFilterParts } from '../json-filters';

/**
 * 筛选谓词是手写的 `json_each` SQL，Prisma 只负责占位符绑定。
 * 这里用真的 PrismaClient 打真的临时库，验的是「客户端 + SQLite 一起跑得通」，
 * 而不是把 SQL 抄一遍自证。
 */
const apiRoot = path.resolve(__dirname, '..', '..', '..');
let dir: string;
let prisma: PrismaClient;

/** 与任务服务一致：多条谓词之间是 AND；无条件时全表返回，方便对照。 */
async function matchIds(tags: string[] | undefined, customFields?: CustomFieldFilter) {
  const parts = jsonFilterParts(tags, customFields);
  if (parts.length === 0) {
    const all = await prisma.task.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    return all.map((row) => row.id);
  }
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT t.id FROM tasks t WHERE ${Prisma.join(parts, ' AND ')} ORDER BY t.id`;
  return rows.map((row) => row.id);
}

async function seed(id: string, tags: string[], customFields: unknown): Promise<void> {
  await prisma.task.create({
    data: {
      id,
      title: id,
      tags: JSON.stringify(tags),
      customFields: customFields === null ? null : JSON.stringify(customFields),
    },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-json-filter-'));
  const url = `file:${path.join(dir, 'atb.db')}`;
  try {
    execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = (error as { stdout?: string; stderr?: string }).stderr;
    throw new Error(`临时库建表失败：${detail ?? String(error)}`);
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  await seed('T-1', ['抓取', '紧急'], { severity: '高', enabled: true, platform: ['ios', 'macos'], cost: 12 });
  await seed('T-2', ['抓取'], { severity: '中', enabled: false, platform: ['linux'], cost: 3.5 });
  await seed('T-3', [], { severity: '高', note: 'no tags' });
  await seed('T-4', ['回归'], {});
  await seed('T-5', [], null);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

describe('tags 筛选', () => {
  it('无标签条件时不施加过滤', async () => {
    expect(await matchIds(undefined)).toEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);
  });

  it('多标签之间是 OR', async () => {
    expect(await matchIds(['紧急', '回归'])).toEqual(['T-1', 'T-4']);
  });

  it('tags 为空数组或 NULL 的卡片不会被误命中', async () => {
    expect(await matchIds(['抓取'])).toEqual(['T-1', 'T-2']);
  });
});

describe('custom_fields[key] 筛选', () => {
  it('字符串值精确匹配', async () => {
    expect(await matchIds(undefined, { severity: ['高'] })).toEqual(['T-1', 'T-3']);
  });

  it('布尔值认 true/1 与 false/0 两种写法', async () => {
    expect(await matchIds(undefined, { enabled: ['true'] })).toEqual(['T-1']);
    expect(await matchIds(undefined, { enabled: ['1'] })).toEqual(['T-1']);
    expect(await matchIds(undefined, { enabled: ['false'] })).toEqual(['T-2']);
  });

  it('数字值按文本比较，含小数', async () => {
    expect(await matchIds(undefined, { cost: ['12'] })).toEqual(['T-1']);
    expect(await matchIds(undefined, { cost: ['3.5'] })).toEqual(['T-2']);
  });

  it('multiselect 展平一层后命中', async () => {
    expect(await matchIds(undefined, { platform: ['macos'] })).toEqual(['T-1']);
    expect(await matchIds(undefined, { platform: ['linux', 'ios'] })).toEqual(['T-1', 'T-2']);
  });

  it('同键多值是 OR，跨键是 AND', async () => {
    expect(await matchIds(undefined, { severity: ['高', '中'] })).toEqual(['T-1', 'T-2', 'T-3']);
    expect(await matchIds(undefined, { severity: ['高'], note: ['no tags'] })).toEqual(['T-3']);
    expect(await matchIds(undefined, { severity: ['中'], note: ['no tags'] })).toEqual([]);
  });

  it('未登记的 key 筛出空集，而不是忽略该条件', async () => {
    expect(await matchIds(undefined, { ghost: ['x'] })).toEqual([]);
  });

  it('空数组值与不合规 key 被丢弃，等价于无该条件', async () => {
    expect(await matchIds(undefined, { severity: [] })).toHaveLength(5);
    expect(await matchIds(undefined, { 'Bad Key': ['x'] })).toHaveLength(5);
  });

  it('custom_fields 为 NULL 或 {} 的卡片不会命中任何字段', async () => {
    expect(await matchIds(undefined, { note: ['no tags'] })).toEqual(['T-3']);
  });

  it('标签与自定义字段组合是 AND', async () => {
    expect(await matchIds(['抓取'], { severity: ['中'] })).toEqual(['T-2']);
    expect(await matchIds(['回归'], { severity: ['中'] })).toEqual([]);
  });
});
