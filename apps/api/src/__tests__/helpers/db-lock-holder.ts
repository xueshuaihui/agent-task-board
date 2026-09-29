import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * 用**另一个进程**把 SQLite 库锁住，模拟真机最常见的现场：同时开了两个本地服务、
 * 或外接盘上另一个进程正在写。给解码器与出口用例造「库被占死」这条错误用。
 *
 * 四条实测口径（都是踩出来的，改这条文件前先读完）：
 *
 * 1. **必须跨进程。** unix 上 SQLite 的库锁是 POSIX 记录锁，同进程自握的锁不与自己冲突：
 *    第一版探针在同进程开第二个 `DatabaseSync` 连接去写，7ms 就成功了，什么也没测到。
 * 2. **WAL 下 `BEGIN EXCLUSIVE` 不等于拿到写锁。** 实测（/tmp/lockprobe 对照跑）：只
 *    `BEGIN EXCLUSIVE` 而不写任何一行时，另一个进程的 INSERT 6ms 就成功了——WAL 的写锁是
 *    到**第一条真正改到数据的语句**才落的。所以这里建一张私有表并插一行：事务内写库，锁到手，
 *    进程被杀时事务自动回滚，表跟着消失，不污染测试库。
 * 3. **子进程必须靠定时器吊着，不能吃 stdin。** 上一版写的是 `process.stdin.resume()`，
 *    而 `stdio[0] = 'ignore'` 时 fd0 指向 /dev/null：resume 立刻读到 EOF，事件循环里没有
 *    待办 → 子进程在打印 `locked` 之后**当场退出**、锁随之释放。表现就是探针静默失效
 *    （131ms「没有报错」）。改成 `setInterval` 后同一套触发稳定阻塞 5.4s 才报
 *    `errcode 5 database is locked`，与真机现场一致。
 * 4. **`locked` 之后还要复核进程仍活着**，否则又变成静默空跑。
 */
const HOLDER_SCRIPT = [
  "const { DatabaseSync } = require('node:sqlite');",
  'const db = new DatabaseSync(process.env.ATB_LOCK_DB);',
  "db.exec('PRAGMA journal_mode=WAL');",
  "db.exec('BEGIN EXCLUSIVE');",
  // 事务内的写：锁在这一条才真正落到手上（见口径 2）。
  "db.exec('CREATE TABLE IF NOT EXISTS atb_lock_probe (n INTEGER)');",
  "db.exec('INSERT INTO atb_lock_probe VALUES (1)');",
  "process.stdout.write('locked\\n');",
  // 见口径 3：靠定时器保持事件循环，不能 resume 一个立刻 EOF 的 stdin。
  'setInterval(() => undefined, 1000);',
  "process.on('SIGTERM', () => process.exit(0));",
].join('\n');

export interface LockHolder {
  release(): Promise<void>;
}

/** 拿到锁才 resolve；15 秒内没拿到就报错（宁可红，也不要静默通过）。 */
export async function holdExclusiveLock(dataDir: string): Promise<LockHolder> {
  const child = spawn(process.execPath, ['-e', HOLDER_SCRIPT], {
    env: { ...process.env, ATB_LOCK_DB: path.join(dataDir, 'jarvis.db') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('锁进程 15s 内没有回 locked')), 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!chunk.includes('locked')) return;
        clearTimeout(timer);
        // 复核：进程还活着才算真的占住了库。
        if (child.exitCode !== null || child.killed) {
          reject(new Error('锁进程打印 locked 后已退出，库锁随之释放（探针失效）'));
          return;
        }
        resolve();
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`锁进程提前退出（code ${String(code)}）`));
      });
    });
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  return {
    release: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
