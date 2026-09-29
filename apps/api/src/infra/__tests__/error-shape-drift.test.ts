/**
 * 数据层抛出形状 · 漂移闸（2026-09-29「报错全部细化」）。
 *
 * 为什么单独有这一支：`contract/db-errors.ts` 的映射表**全部照实测写**，不是照 Prisma
 * 文档猜的——文档与本地引擎的实际抛法至少有三处不一致（裸 SQL 的约束违规不翻译成 P2003
 * 而是 P2010 + SQLite 扩展码；初始化失败挂在 `name/errorCode` 而不是 `code`；node:sqlite
 * 用自己的 `errcode`）。既然是照实测写的，就得有人盯着「实测是否还是这样」：Prisma 小版本
 * 一升级就把形状改了个四不认，解码器会静默退回 INTERNAL，用户看到的又是那句
 * 「本地服务内部错误」——本次缺陷被压住整整一棒就是这么来的。
 *
 * 所以这里的每条 `it` 都是同一个句式：**真造一条错误 → 先钉形状（name/code/meta 键位），
 * 再钉解码结果（细化码）**。钉形状那条红了就说明上游改了抛法，得回去订映射表；
 * 只钉解码结果会掩盖漂移（换了形状也可能凑巧给出同一个码）。
 *
 * 错误全部由真实触发产生（临时库、真约束、真文件权限、真锁），不手工构造。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTestApp, type TestApp } from '../../__tests__/helpers/http-app';
import { holdExclusiveLock } from '../../__tests__/helpers/db-lock-holder';
import { decodeDataLayerError } from '../../contract/db-errors';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

/** 抛出的错误对象上的判据键：实测就是这三个位置，别的都靠不住。 */
type Shape = Error & { code?: string; errcode?: number; errorCode?: string; meta?: Record<string, unknown> };

/** 跑一条必然失败的写法（异步：Prisma 面），把抛出原样交回来。 */
async function grab(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`形状漂移：抛出值不是 Error（${String(error)}）`);
    return error;
  }
  throw new Error('这条触发没有报错，探针失效了（映射表不能照猜的写）');
}

/** 同上，node:sqlite 是同步 API。 */
function grabSync(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`形状漂移：抛出值不是 Error（${String(error)}）`);
    return error;
  }
  throw new Error('这条触发没有报错，探针失效了（映射表不能照猜的写）');
}

/** 解码并给出细化码 + 折叠区原文；解码器回 null 视为缺陷（除显式判 null 的那条）。 */
function decodeOf(error: Error): { code: string; message: string; detail: string } {
  const decoded = decodeDataLayerError(error);
  if (!decoded) {
    const e = error as Shape;
    throw new Error(`解码器回 null：${e.name} / code=${String(e.code)} / ${e.message.slice(0, 80)}`);
  }
  return { code: decoded.code, message: decoded.message, detail: String(decoded.context.detail ?? '') };
}

/**
 * 「库被占死」这条错误的造法在 `helpers/db-lock-holder.ts`，四条实测口径逐条写了为什么。
 * 下面 `环境面` 那支用它。
 */

describe('Prisma 模型方法面（有专属 P2 码的那条路）', () => {
  it('唯一冲突 P2002：meta.modelName + meta.target 数组在位 → DATA_DUPLICATE 且带字段名', async () => {
    await t.prisma.$executeRawUnsafe(`DELETE FROM groups WHERE id IN ('drift_g1','drift_g2')`);
    await t.prisma.group.create({ data: { id: 'drift_g1', name: '漂移探针重名组' } });
    const error = await grab(() => t.prisma.group.create({ data: { id: 'drift_g2', name: '漂移探针重名组' } }));
    const e = error as Shape;

    // 形状闸
    expect(e.name).toBe('PrismaClientKnownRequestError');
    expect(e.code).toBe('P2002');
    expect(e.meta?.modelName).toBe('Group');
    expect(e.meta?.target).toEqual(['name']);

    const decoded = decodeOf(error);
    expect(decoded.code).toBe('DATA_DUPLICATE');
    expect(decoded.message).toContain('name');
    expect(decoded.detail.length).toBeGreaterThan(0);
  });

  it('外键占用 P2003：SQLite 侧 meta.constraint 是 null，判据只能落在 name/code 上', async () => {
    await t.prisma.$executeRawUnsafe(`DELETE FROM api_tokens WHERE id = 'drift_k1'`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM task_runs WHERE id = 'drift_r1'`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM tasks WHERE id = 'drift_t1'`);
    await t.prisma.task.create({ data: { id: 'drift_t1', title: '漂移探针任务' } });
    await t.prisma.taskRun.create({ data: { id: 'drift_r1', taskId: 'drift_t1', runNumber: 91, status: 'RUNNING' } });
    await t.prisma.apiToken.create({ data: { id: 'drift_k1', name: '漂移探针 Token', tokenHash: 'drift_hash_1' } });
    await t.prisma.taskRun.update({ where: { id: 'drift_r1' }, data: { tokenId: 'drift_k1' } });

    const error = await grab(() => t.prisma.apiToken.delete({ where: { id: 'drift_k1' } }));
    const e = error as Shape;

    expect(e.name).toBe('PrismaClientKnownRequestError');
    expect(e.code).toBe('P2003');
    // 实测 constraint 恒为 null：别把它写进判据，否则等于没判。
    expect(e.meta?.constraint ?? null).toBeNull();
    expect(typeof e.meta?.modelName).toBe('string');

    const decoded = decodeOf(error);
    expect(decoded.code).toBe('DATA_STILL_REFERENCED');
    expect(decoded.message).toContain('引用');
  });

  it('记录已不在 P2025：更新一条不存在的行 → NOT_FOUND（不是内部错误）', async () => {
    const error = await grab(() =>
      t.prisma.task.update({ where: { id: 'drift_missing' }, data: { title: 'x' } }),
    );
    const e = error as Shape;
    expect(e.name).toBe('PrismaClientKnownRequestError');
    expect(e.code).toBe('P2025');
    expect(decodeOf(error).code).toBe('NOT_FOUND');
  });

  it('查询形状写错（PrismaClientValidationError）：没有 code，只能按 name 判 → INTERNAL', async () => {
    const error = await grab(() => t.prisma.task.findUnique({ where: {} as never }));
    expect(error.name).toBe('PrismaClientValidationError');
    const decoded = decodeOf(error);
    expect(decoded.code).toBe('INTERNAL');
    // 这是我们自己的代码问题，不该给用户看引擎原文之外的东西，但 detail 必须在位。
    expect(decoded.detail.length).toBeGreaterThan(0);
  });

  // 缺表 / 缺列在模型方法面是 P2021/P2022（`meta.table`、`meta.column`），
  // 与裸 SQL 面的 P2010+主码 1 是同一件事的两张脸。真 HTTP 出口用例（error-refinement-http.test.ts）
  // 第一次跑就抓到这一对没被认出来——升级没跑完时最常见的就是这个形状，必须钉住。
  it('缺表 P2021：meta.table 带 `main.` 前缀 → SCHEMA_MISMATCH 且文案点名缺哪张表', async () => {
    await t.prisma.$executeRawUnsafe('ALTER TABLE notifications RENAME TO drift_notifications_hidden');
    let error: Error;
    try {
      error = await grab(() => t.prisma.notification.findMany());
    } finally {
      // 本文件的其余用例还要用这张表：探针用完立刻还原。
      await t.prisma.$executeRawUnsafe('ALTER TABLE drift_notifications_hidden RENAME TO notifications');
    }
    const e = error as Shape;

    expect(e.name).toBe('PrismaClientKnownRequestError');
    expect(e.code).toBe('P2021');
    expect(e.meta?.table).toBe('main.notifications');
    expect(e.meta?.modelName).toBe('Notification');

    const decoded = decodeOf(error);
    expect(decoded.code).toBe('SCHEMA_MISMATCH');
    expect(decoded.message).toContain('缺少表');
    expect(decoded.message).toContain('notifications');
    expect(decoded.message).not.toContain('main.');
  });

  it('缺列 P2022：meta.column 是 `main.groups.name` → SCHEMA_MISMATCH 说缺字段', async () => {
    await t.prisma.$executeRawUnsafe('ALTER TABLE groups RENAME COLUMN name TO drift_name_hidden');
    let error: Error;
    try {
      error = await grab(() => t.prisma.group.findMany());
    } finally {
      await t.prisma.$executeRawUnsafe('ALTER TABLE groups RENAME COLUMN drift_name_hidden TO name');
    }
    const e = error as Shape;

    expect(e.name).toBe('PrismaClientKnownRequestError');
    expect(e.code).toBe('P2022');
    expect(e.meta?.column).toBe('main.groups.name');

    const decoded = decodeOf(error);
    expect(decoded.code).toBe('SCHEMA_MISMATCH');
    expect(decoded.message).toContain('缺少字段');
    expect(decoded.message).toContain('groups.name');
  });
});

describe('裸 SQL 面（$executeRawUnsafe：引擎不翻成 P2003/P2002，一律 P2010 + SQLite 扩展码）', () => {
  beforeAll(async () => {
    // 这几条触发都要「行真的存在」：UPDATE 不匹配任何行时 SQLite 根本不写、也就不会撞约束。
    await t.prisma.$executeRawUnsafe(`DELETE FROM comments WHERE id IN ('drift_c1','drift_c2')`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM notifications WHERE id = 'drift_n1'`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM groups WHERE id IN ('drift_g9','drift_u1','drift_u2')`);
    await t.prisma.$executeRawUnsafe(`DELETE FROM tasks WHERE id = 'drift_t9'`);
    await t.prisma.group.create({ data: { id: 'drift_g9', name: '漂移探针可空列组' } });
    await t.prisma.task.create({ data: { id: 'drift_t9', title: '漂移探针评论宿主' } });
  });

  /**
   * 一条裸 SQL 触发：先钉「仍是 P2010 + meta.code 字符串扩展码」，再钉细化码。
   * 扩展码 = (子类型 << 8) | 19，主码 19 是 SQLITE_CONSTRAINT。
   */
  function rawCase(label: string, sql: string, expected: { code: string; sqlite?: number }): void {
    it(label, async () => {
      const error = await grab(() => t.prisma.$executeRawUnsafe(sql));
      const e = error as Shape;
      expect(e.name).toBe('PrismaClientKnownRequestError');
      expect(e.code).toBe('P2010');
      const sqlite = Number(e.meta?.code);
      expect(Number.isFinite(sqlite)).toBe(true);
      if (expected.sqlite !== undefined) expect(sqlite).toBe(expected.sqlite);
      expect(decodeOf(error).code).toBe(expected.code);
    });
  }

  // (3<<8)|19 = 787 外键：本次缺陷的原始形状——它过去落进 INTERNAL，用户只看到「本地服务内部错误」
  rawCase('外键违规 787 → DATA_STILL_REFERENCED', `INSERT INTO comments (id, task_id, run_id, author_type, content)
      VALUES ('drift_c2','drift_t9','drift_不存在的 run','user','x')`, { code: 'DATA_STILL_REFERENCED', sqlite: 787 });

  // (6<<8)|19 = 1555 主键：一条语句里两个同 id，引擎给的是 PRIMARY KEY 子类型
  rawCase('主键冲突 1555 → DATA_DUPLICATE', `INSERT INTO comments (id, task_id, run_id, author_type, content)
      VALUES ('drift_c1','drift_t9',NULL,'user','一'),
             ('drift_c1','drift_t9',NULL,'user','二')`, { code: 'DATA_DUPLICATE', sqlite: 1555 });

  // (8<<8)|19 = 2067 唯一索引（`uniq_groups_name`）：与主键不同一条路，两种都得认
  rawCase('唯一索引冲突 2067 → DATA_DUPLICATE', `INSERT INTO groups (id, name)
      VALUES ('drift_u1','漂移探针重复组名'),
             ('drift_u2','漂移探针重复组名')`, { code: 'DATA_DUPLICATE', sqlite: 2067 });

  // (1<<8)|19 = 275 CHECK、(5<<8)|19 = 1299 NOT NULL：形状上是「不合 DDL」，属我方缺陷，
  // 不冒充用户能修的冲突码——但原文进 detail，折叠区查得到。
  rawCase('CHECK 违规 275 → INTERNAL（不合表结构约束）', `INSERT INTO notifications (id, kind, message)
      VALUES ('drift_n1','sms-不在词表里','x')`, { code: 'INTERNAL', sqlite: 275 });
  rawCase('NOT NULL 违规 1299 → INTERNAL', `UPDATE groups SET name = NULL WHERE id = 'drift_g9'`, {
    code: 'INTERNAL',
    sqlite: 1299,
  });

  // 主码 1 = SQLITE_ERROR：迁移没跑完时最常见的两种（缺表 / 缺列）
  rawCase('缺表 → SCHEMA_MISMATCH', `SELECT id FROM drift_no_such_table`, { code: 'SCHEMA_MISMATCH' });
  rawCase('缺列 → SCHEMA_MISMATCH', `SELECT drift_no_such_column FROM tasks`, { code: 'SCHEMA_MISMATCH' });
});

describe('环境面（用户自己能修的那几条：打不开 / 被占 / 只读 / 坏了）', () => {
  it('Prisma 打不开库文件（数据目录不存在）→ STORAGE_UNAVAILABLE', async () => {
    const ghost = mkdtempSync(path.join(tmpdir(), 'drift-init-'));
    const { PrismaClient } = await import('@prisma/client');
    const broken = new PrismaClient({
      datasourceUrl: `file:${path.join(ghost, 'gone', 'jarvis.db')}?journal_mode=WAL`,
      log: [],
    });
    try {
      const error = await grab(() => broken.$queryRawUnsafe(`SELECT 1`));
      const e = error as Shape;
      // 形状闸（这一条最反直觉，实测为准）：能用的只有 `name`；`errorCode` / `retryable`
      // 是「挂了名、值为 undefined」的自有键（Object.keys 里有、JSON.stringify 里没），
      // 照 Prisma 文档拿 errorCode 当判据会永远走兜底。真信息只在 message 的
      // `Error code 14: Unable to open the database file` 里。
      expect(e.name).toBe('PrismaClientInitializationError');
      expect(e.code).toBeUndefined();
      expect(Object.keys(e)).toContain('errorCode');
      expect(e.errorCode).toBeUndefined();
      expect(e.message).toMatch(/Error code 14.*Unable to open the database file/s);
      expect(decodeOf(error).code).toBe('STORAGE_UNAVAILABLE');
    } finally {
      await broken.$disconnect().catch(() => undefined);
      rmSync(ghost, { recursive: true, force: true });
    }
  });

  // 真机最常见、也最难在离线 fixture 里想到的一条：库被另一个进程占死。
  // 触发方式照现场做——**另一个进程**持着写事务（等价于「同时开了两个本地服务」里另一边
  // 正在写），再让 Prisma 去写。三个坑都记在 `helpers/db-lock-holder.ts`：必须跨进程
  // （同进程自握的锁不与自己冲突，第一版探针写入 7ms 就成功了）、`BEGIN EXCLUSIVE` 之后
  // 要真的改到一行（WAL 的写锁到第一条写入才落，否则探针静默失效）、子进程靠定时器吊着
  // （`stdio[0]='ignore'` 时 `stdin.resume()` 立刻 EOF，进程打印 locked 就退，锁随之释放）。
  // 等的是引擎自己的 socket 超时（实测约 5 秒），所以 timeout 单独放宽。
  // 形状必须钉住：连接面的错也挂着 KnownRequestError 的 name，
  // 解码器一旦把 P1xxx 排在模型面之后，这里就会静默退回 INTERNAL。
  it('另一个进程持排他写锁导致查询超时（P1008）→ STORAGE_LOCKED，不再是内部错误', async () => {
    const holder = await holdExclusiveLock(t.dir);
    try {
      const error = await grab(() => t.prisma.group.create({ data: { id: 'drift_g_lock', name: '锁探针组' } }));
      const e = error as Shape;

      expect(e.name).toBe('PrismaClientKnownRequestError');
      expect(e.code).toBe('P1008');
      expect(e.message).toMatch(/timeout|failed to respond/i);

      const decoded = decodeOf(error);
      expect(decoded.code).toBe('STORAGE_LOCKED');
      // 文案要指名「另一个进程」这个现场并给出做得到的动作，而不是「内部错误」。
      expect(decoded.message).toContain('另一个进程');
      expect(decoded.message).not.toContain('内部错误');
      expect(decoded.detail.length).toBeGreaterThan(0);
    } finally {
      await holder.release();
      await t.prisma.$executeRawUnsafe(`DELETE FROM groups WHERE id = 'drift_g_lock'`).catch(() => undefined);
    }
  }, 90_000);

  it('node:sqlite 读到不是数据库的文件（errcode 26）→ STORAGE_CORRUPT', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'drift-notadb-'));
    const file = path.join(dir, 'not-a-db.db');
    writeFileSync(file, '这不是数据库文件，只是文本\n'.repeat(64));
    // DatabaseSync 的构造是惰性的，第一次 exec 才抛——落点必须在语句上。
    const db = new DatabaseSync(file);
    try {
      const error = grabSync(() => db.exec('SELECT count(*) FROM sqlite_master'));
      expect((error as Shape).code).toBe('ERR_SQLITE_ERROR');
      expect((error as Shape).errcode).toBe(26);
      expect(decodeOf(error).code).toBe('STORAGE_CORRUPT');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('node:sqlite 的目录不存在（errcode 14）→ STORAGE_UNAVAILABLE', () => {
    const error = grabSync(() => {
      const db = new DatabaseSync(path.join(tmpdir(), `drift-missing-${Date.now()}`, 'gone', 'x.db'));
      try {
        db.exec('SELECT 1');
      } finally {
        db.close();
      }
    });
    expect((error as Shape).errcode).toBe(14);
    expect(decodeOf(error).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('只读文件上的写（errcode 8）→ STORAGE_READONLY', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'drift-ro-'));
    const file = path.join(dir, 'readonly.db');
    const maker = new DatabaseSync(file);
    maker.exec('CREATE TABLE t (id TEXT PRIMARY KEY);');
    maker.close();
    chmodSync(file, 0o444);
    try {
      const error = grabSync(() => {
        const db = new DatabaseSync(file);
        try {
          db.exec(`INSERT INTO t VALUES ('1');`);
        } finally {
          db.close();
        }
      });
      expect((error as Shape).errcode).toBe(8);
      expect(decodeOf(error).code).toBe('STORAGE_READONLY');
    } finally {
      chmodSync(file, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('第二个连接抢不到写锁（SQLITE_BUSY/LOCKED）→ STORAGE_LOCKED', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'drift-busy-'));
    const file = path.join(dir, 'busy.db');
    const holder = new DatabaseSync(file);
    holder.exec('CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT NOT NULL);');
    holder.exec('BEGIN EXCLUSIVE;');
    holder.exec(`INSERT INTO t VALUES ('1','x');`);
    try {
      // busy_timeout 显式设 0：不等锁直接抛。真实壳层里「同时开了两个本地服务」就是这个形状。
      const error = grabSync(() => {
        const other = new DatabaseSync(file);
        try {
          other.exec('PRAGMA busy_timeout=0;');
          other.exec('BEGIN IMMEDIATE;');
          other.exec(`INSERT INTO t VALUES ('2','y');`);
        } finally {
          other.close();
        }
      });
      expect((error as Shape).code).toBe('ERR_SQLITE_ERROR');
      expect(decodeOf(error).code).toBe('STORAGE_LOCKED');
    } finally {
      holder.exec('ROLLBACK;');
      holder.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('包装层与兜底', () => {
  it('迁移执行器那种「前缀 + cause」的裹法：顺着 cause 仍给细化码，外层前缀并进 detail', () => {
    const inner = grabSync(() => {
      const db = new DatabaseSync(path.join(tmpdir(), `drift-cause-${Date.now()}`, 'gone', 'x.db'));
      try {
        db.exec('SELECT 1');
      } finally {
        db.close();
      }
    });
    // bootstrap.ts 的 `迁移 00NN_x 失败：…` 就是这个形状（保住 cause 才有这一次解码）。
    const wrapped = new Error('迁移 0099_漂移探针 失败：' + inner.message, { cause: inner });
    const decoded = decodeOf(wrapped);
    expect(decoded.code).toBe('STORAGE_UNAVAILABLE');
    expect(decoded.detail).toContain('迁移 0099_漂移探针 失败');
  });

  it('cause 自环（a.cause=b、b.cause=a）不许把解码器拖进无限递归', () => {
    const a = new Error('a');
    const b = new Error('b');
    Object.assign(a, { cause: b });
    Object.assign(b, { cause: a });
    expect(decodeOf(a).code).toBe('INTERNAL');
  });

  it('普适未知异常：不硬编语义，但仍是 INTERNAL + 原文一行（细化不许吃掉现场）', () => {
    const decoded = decodeOf(new Error('普适未知异常：boom'));
    expect(decoded.code).toBe('INTERNAL');
    expect(decoded.detail).toContain('普适未知异常：boom');
  });

  it('非 Error 的抛出值不做猜：交回 null，由出口保留自己的兜底', () => {
    expect(decodeDataLayerError('只是一串字符')).toBeNull();
    expect(decodeDataLayerError(null)).toBeNull();
  });

  it('超长原文收口成一行：一条 600 字的 SQL 回显不许糊在界面上', () => {
    const decoded = decodeOf(new Error(`SELECT ${'x'.repeat(600)}`));
    expect(decoded.detail).not.toContain('\n');
    expect(decoded.detail.length).toBeLessThanOrEqual(221); // brief 的 220 字上限 + 省略号
  });
});
