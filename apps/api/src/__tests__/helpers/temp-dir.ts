import { rmSync } from 'node:fs';

/**
 * 临时数据目录的统一拆除口（Windows CI 的第一道门禁修复，run 36329045226）。
 *
 * 症状：win-x64 的 22 个测试文件整文件红，日志里 81 次
 * `Error: EBUSY: resource busy or locked, unlink 'C:\Users\RUNNER~1\AppData\Local\Temp\atb-it-XXXXXX\jarvis.db'`
 * 全部落在 `afterAll` 的 rmSync 上（另有一次 `Error: Hook timed out in 10000ms.`）。
 *
 * 根因：POSIX 允许删除仍有打开句柄的文件，Windows 不允许。各 harness 已经是
 * `await prisma.$disconnect()` 紧跟 rmSync 的顺序，但 Prisma 的查询引擎是加载进本进程的
 * 原生库，它在 `$disconnect()` 的 promise resolve **之后**才真正把 SQLite 文件句柄释放掉，
 * 所以「先 disconnect 再删」这个模型没错、时机在 Windows 上却不够。
 *
 * 修法：优先用 Node `rmSync` 自带的重试（文档口径：只对 EBUSY / EPERM / ENOTEMPTY / EMFILE
 * 重试，退避 retryDelay），重试耗尽后若仍是这一类码就容忍——CI runner 上漏一个临时目录是无害的，
 * 吞掉真实失败才有害；其余错误码原样抛。异步版在两轮之间让事件循环转一圈，
 * 给引擎线程/JS 续体留出真正释放句柄的机会。
 *
 * 时间预算：三轮的最坏总耗时 ≈ 1.5s + 0.3s + 0.5s + 0.3s + 0.5s ≈ 3.1s，
 * 稳在 vitest 默认 hookTimeout（10s）之内——`apps/api/vitest.config.ts` 只覆写了 testTimeout（30s），
 * hookTimeout 用的是 vitest 的默认值。
 */

/** 只吞「句柄还没释放」这一类残留码，与 Node rmSync 的重试白名单同口径。 */
const BENIGN_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE']);

/** 每轮的重试预算；首轮最重（覆盖引擎异步释放的常态），后两轮只为兜住事件循环让位后的情况。 */
const ROUNDS: ReadonlyArray<{ maxRetries: number; retryDelay: number }> = [
  { maxRetries: 6, retryDelay: 250 },
  { maxRetries: 2, retryDelay: 250 },
  { maxRetries: 2, retryDelay: 250 },
];

/** 异步版两轮之间让位给事件循环的毫秒数。 */
const YIELD_MS = 300;

type Outcome = { kind: 'removed' } | { kind: 'benign' } | { kind: 'fatal'; error: unknown };

function errorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return '';
  return String((error as { code: unknown }).code);
}

function rmOnce(dir: string, round: { maxRetries: number; retryDelay: number }): Outcome {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: round.maxRetries,
      retryDelay: round.retryDelay,
    });
    return { kind: 'removed' };
  } catch (error) {
    // ENOENT 由 force:true 挡掉了；走到这里只剩两类：白名单内的残留，与真错误。
    return BENIGN_CODES.has(errorCode(error)) ? { kind: 'benign' } : { kind: 'fatal', error };
  }
}

/**
 * 同步拆除：删干净返回 true，被 Windows 句柄残留挡住返回 false，真实错误照抛。
 * 用在用例体内的目录重置上（那里没有 hook 时间预算，也不该 await）。
 */
export function removeTempDirSync(dir: string): boolean {
  const outcome = rmOnce(dir, ROUNDS[0]!);
  if (outcome.kind === 'fatal') throw outcome.error;
  return outcome.kind === 'removed';
}

/**
 * 异步拆除：给句柄释放留两轮让位机会，用在 afterAll / dispose 上。
 * 返回 false 表示「试完了还删不掉」——临时目录漏在 runner 上，不升级为用例失败。
 */
export async function removeTempDir(dir: string): Promise<boolean> {
  for (let index = 0; index < ROUNDS.length; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, YIELD_MS));
    const outcome = rmOnce(dir, ROUNDS[index]!);
    if (outcome.kind === 'removed') return true;
    if (outcome.kind === 'fatal') throw outcome.error;
  }
  return false;
}
