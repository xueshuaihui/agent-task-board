import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/** 20.1：lease_id / 各表主键用 UUID v7（时间有序，便于按 id 粗排）。 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 20.1：Agent Token 明文 `atb_` + 40 位 base62，只在生成时返回一次。 */
export function generateAgentToken(): { plaintext: string; tokenHash: string } {
  const raw = randomBytes(40);
  let plaintext = '';
  for (const byte of raw) plaintext += BASE62[byte % 62]!;
  return { plaintext: `atb_${plaintext}`, tokenHash: hashToken(plaintext) };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * 短号分配：`T-` / `R-` 由 id_sequences 给出，删除后号位不复用。
 * 必须在调用方的事务里执行，SQLite 的 UPDATE...RETURNING 与写锁同生命周期。
 */
export async function nextSequence(
  tx: Prisma.TransactionClient,
  name: 'task' | 'run',
): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ next: number }[]>(
    `UPDATE id_sequences SET next = next + 1 WHERE name = ? RETURNING next`,
    name,
  );
  const next = rows[0]?.next;
  if (typeof next !== 'number') {
    throw new Error(`id_sequences 缺少 ${name} 行（迁移 0001_init 未执行？）`);
  }
  return next;
}

export async function nextTaskId(tx: Prisma.TransactionClient): Promise<string> {
  return `T-${await nextSequence(tx, 'task')}`;
}

export async function nextRunId(tx: Prisma.TransactionClient): Promise<string> {
  return `R-${await nextSequence(tx, 'run')}`;
}

/** 主键 UUID 的包装，读代码时能一眼看出「这列存的是无括号 UUID」（20.1）。 */
export function newId(): string {
  return uuidv7();
}

/** 导入时把文件里的短号换成新号（6.12.2 reassign），同时改写引用。 */
export function reassignPrefix(id: string, prefix: 'T-' | 'R-'): boolean {
  return typeof id === 'string' && id.startsWith(prefix);
}
