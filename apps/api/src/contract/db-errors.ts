/**
 * 数据层异常解码器（2026-09-29「报错全部细化」）。
 *
 * 存在理由：`ApiExceptionFilter` 与 `mcp.server.ts` 的 `toCallToolResult` 过去只认
 * `ApiException`，其余抛出（Prisma 引擎的、node:sqlite 的、任何裸 Error）一律洗成
 * `INTERNAL` → 界面「本地服务内部错误」。这一类里最要命的形状恰恰是**用户自己能修**的：
 * 库文件损坏、数据目录在只读卷上、同时开了两个本地服务把库锁住、迁移没跑完缺列。
 * 把它们统一报成「内部错误」等于把排障成本全推给用户（本次缺陷「删除卡片任务报
 * 本地服务内部错误」就是这么被压了整整一棒，直到顺着堆栈才看到 FOREIGN KEY）。
 *
 * 形状全部来自实测（`src/infra/__tests__/error-shape-drift.test.ts` 逐条触发并把形状钉成断言，
 * 不是照 Prisma 文档猜；那份测试红了就说明上游改了抛法，得回来订这张表）：
 *   * `PrismaClientKnownRequestError` P2002 → `meta.modelName` + `meta.target: ['name']`；
 *   * P2003 → `meta.modelName` + `meta.constraint: null`（SQLite 侧不回约束名，别指望它）；
 *   * P2025 → `meta.cause: 'No record was found for an update.'`；
 *   * P2021 → `meta.table: 'main.notifications'`、P2022 → `meta.column: 'main.groups.name'`
 *     （模型方法面的「缺表 / 缺列」，升级没跑完时最常见的形状。带 `main.` 前缀，进文案前要去掉；
 *     同一件事在裸 SQL 面是 P2010+主码 1，两张脸都得认——这条是 `error-refinement-http.test.ts`
 *     第一次跑真 HTTP 出口时抓出来的漏网形状）；
 *   * `$executeRawUnsafe` 这条路上引擎**不翻译**：约束违规一律 `P2010`，
 *     `meta.code` 是 SQLite 扩展结果码的**字符串**（`'787'` 外键 / `'1555'` 主键 /
 *     `'2067'` 唯一索引 / `'275'` CHECK / `'1299'` NOT NULL / `'1'` 语法或 no such table），
 *     `meta.message` 才是原文。所以同一件「撞外键」的事，模型方法面是 P2003、
 *     裸 SQL 面是 P2010+787——两套都得认，漏一套就退回 INTERNAL。
 *   * `PrismaClientInitializationError` → `name` 可信，`errorCode`/`retryable` 是「挂了名、值为
 *     undefined」的坑；真信息在 message：`Error code 14: Unable to open the database file`；
 *   * 库被别的进程占死 → **`name: 'PrismaClientKnownRequestError'` 但 `code: 'P1008'`**（连接面的错
 *     也挂「已知请求错」的 name），message 是 `Socket timeout (the database failed to respond …)`。
 *     这条是拿真 sidecar + 第二个连接 `BEGIN EXCLUSIVE` 打出来的，也是 P1xxx 那支护住在最前面的原因；
 *   * `PrismaClientValidationError` → 没有 code，只有 name（是我们把查询形状写错了）；
 *   * node:sqlite（迁移执行器、备份恢复、首启搬迁走的就是它）→ `code:'ERR_SQLITE_ERROR'`
 *     + `errcode` 数值 + `errstr`（实测 26 file is not a database / 14 unable to open /
 *     5 database is locked / 8 attempt to write a readonly database）。
 *
 * 三条硬约束：
 *   1. **不把裸 SQL 递到人面前**：原文（含语句片段、内部列名）只进 `context.detail`，
 *      由前端折叠区承载；`message` 恒为中文一行、说清「现在怎么办」。
 *   2. 解不出来的不硬编：交回 `INTERNAL`，但 `context.detail` 仍带原文一行——
 *      退回原状只发生在「我们真的不认识」这一种情况。
 *   3. REST 与 MCP 共用这一份（13 章码表只有一份实现），两个出口都不许自己另猜。
 *   4. 被 `new Error('前缀：…', { cause })` 裹过的（迁移执行器就是这形状）顺 `cause` 再解一层，
 *      外层前缀并进 `detail`——所以**包装错误时必须带 cause**，否则细化码在这里就断了。
 */

import { ApiException, type ErrorCode } from './errors';

/**
 * SQLite 结果码。低 8 位是主码，`code & 0xFF` 才可比——扩展码（约束类）把违规种类
 * 放在高字节：`787 = (3<<8)|19`、`1555 = (6<<8)|19`、`275 = (1<<8)|19`、`1299 = (5<<8)|19`，
 * 全部主码 19 = SQLITE_CONSTRAINT。裸 `'FOREIGN KEY constraint failed'` 与
 * `'UNIQUE constraint failed: comments.id'` 的区分就藏在这个高字节里。
 */
const SQLITE_CONSTRAINT = 19;
const SUBTYPE = (code: number): number => code >> 8;
/** 约束子类型（实测自 P2010 的 meta.code 与 node:sqlite 的 errcode，两边同一套编号）。 */
const CHECK = 1;
const FOREIGN_KEY = 3;
const NOT_NULL = 5;
const PRIMARY_KEY = 6;
const UNIQUE = 8;
/** 非约束类主码。 */
const SQLITE_PERM = 3;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;
const SQLITE_READONLY = 8;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export interface DecodedError {
  code: ErrorCode;
  message: string;
  /** 上下文一律 snake_case（13 章错误体的既有口径）。detail 里是引擎原文，只给折叠区。 */
  context: Record<string, unknown>;
}

/** 引擎原文进错误体前收口：压成一行、截断，避免一条 400 字的 SQL 回显糊在界面上。 */
function brief(text: unknown, limit = 220): string {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 从 `Invalid \`p.group.create()\` invocation in …` 这种多行消息里挑出引擎那句真话。 */
function engineLine(message: unknown): string {
  const raw = String(message ?? '');
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  // Prisma 的 message 尾部才是约束原文（头部是调用点回显 + 源码位置）。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/constraint|no such |unable to open|not a database|locked|readonly/i.test(line)) return line;
  }
  return lines[lines.length - 1] ?? '';
}

/** Prisma 的 model 名进错误体时保持原样（PascalCase），但界面文案用中文列名更可读。 */
function modelName(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.modelName;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** P2002 的 target（数组或串）与 1555/2067 原文里的 `table.col` 收敛成同一形状。 */
function conflictFields(meta: Record<string, unknown> | undefined, text: string): string[] {
  const target = meta?.target;
  if (Array.isArray(target)) return target.map((item) => String(item));
  if (typeof target === 'string' && target.length > 0) return [target];
  const inline = /constraint failed:\s*(.+)$/i.exec(text);
  return inline ? [inline[1].trim()] : [];
}

/** 从任意抛出上取数值码：Prisma 的 `meta.code` 是字符串，node:sqlite 的 `errcode` 是数值。 */
function numericCode(error: Record<string, unknown>): number | null {
  const meta = error.meta as Record<string, unknown> | undefined;
  const fromMeta = Number(meta?.code);
  if (Number.isFinite(fromMeta) && meta?.code !== undefined && meta?.code !== null && meta?.code !== '') {
    return fromMeta;
  }
  const errcode = Number(error.errcode ?? error.errno);
  return Number.isFinite(errcode) && errcode !== 0 ? errcode : null;
}

/**
 * 环境类（磁盘/权限/损坏/被占）的用户文案：这几条必须给动作，
 * 光说「坏了」等于没说。指向的是壳层里真实存在的入口（设置页 → 备份与恢复）。
 */
function storage(code: ErrorCode, message: string, error: unknown): DecodedError {
  return { code, message, context: { detail: brief(engineLine((error as Error)?.message ?? error)) } };
}

/**
 * 兜底：认不出来的抛出**不猜语义**，但仍带原文一行。
 * 与旧版过滤器的区别只有 `detail`——状态码与 `INTERNAL` 原样保留，
 * 于是「细化」是纯增益：认识的给出动作，不认识的至少留下现场。
 */
function internalFallback(e: Error, sourceCode?: string): DecodedError {
  return {
    code: 'INTERNAL',
    message: '服务内部错误',
    context: {
      ...(sourceCode && sourceCode.length > 0 ? { source_code: sourceCode } : {}),
      detail: brief(engineLine(e.message) || e.message),
    },
  };
}

/**
 * 主入口。返回 `null` 只发生在「根本不是 Error」（`throw 'x'` 的字符串、null、被 catch
 * 的 rejection 值）——调用方据此保留自己原来的兜底，不硬编。
 * 其余情况一律给 `ApiException` 等价三元组：命中数据层形状就给细化码与文案，
 * 命不中就 `INTERNAL` + `context.detail`，所以返回值**总是**比旧版「裸 INTERNAL」更有信息量。
 *
 * `depth` 是内部用的 cause 链深度（上限 4）：循环 `a.cause=b; b.cause=a` 的畸形错误
 * 不能把解码器拖进无限递归，调用方不必传。
 */
export function decodeDataLayerError(error: unknown, depth = 0): DecodedError | null {
  if (!(error instanceof Error)) return null;
  const e = error as Record<string, unknown> & Error;
  const name = typeof e.name === 'string' ? e.name : '';
  const code = typeof e.code === 'string' ? e.code : '';
  const meta = (e.meta ?? undefined) as Record<string, unknown> | undefined;
  const sqlite = numericCode(e);
  const raw = engineLine(e.message);

  // ── Prisma 连接面（P1xxx）：必须排在模型方法面之前 ──────────────────────────────
  // 实测（2026-09-29，真 sidecar + 第二个连接持 `BEGIN EXCLUSIVE` 后发写请求）：
  // 库被占死时引擎给的是 **`name: 'PrismaClientKnownRequestError'` + `code: 'P1008'`**，
  // 消息是 `Socket timeout (the database failed to respond to a query within the configured timeout)`。
  // 也就是说「连接面」的错误也挂着「已知请求错」的 name——放在下面那条 `name === Known` 的分支之后，
  // P1008 会被它整支吞掉并退回 INTERNAL，于是「同时开了两个本地服务」这种最常见的现场
  // 又变回「本地服务内部错误」。这一支提到最前面，才谈得上细化。
  if (/^P1\d{3}$/.test(code)) {
    // P1008 查询超时 / P1009 连接池用满：都是「有人在写，你等一下」，动作是给机会重试而不是查目录。
    if (code === 'P1008' || code === 'P1009' || /timeout|failed to respond/i.test(raw)) {
      return storage(
        'STORAGE_LOCKED',
        '本地数据库没有及时响应（通常是另一个进程正占着它写，或同时开了两个本地服务）。请等待片刻重试；持续如此就只保留一个本地服务',
        e,
      );
    }
    return storage(
      'STORAGE_UNAVAILABLE',
      '本地数据库连不上：数据目录可能不在可写位置或被移动过。请检查目录后重启本地服务',
      e,
    );
  }

  // ── Prisma 模型方法面：约束违规有专属 P2 码 ───────────────────────────────────
  // 只认 P2xxx / P4xxx（已知请求错）；P1xxx 已在上面那支护住，name 撞上 Known 也不会漏过去。
  if (name === 'PrismaClientKnownRequestError' || /^P[24]\d{3}$/.test(code)) {
    if (code === 'P2002') {
      const fields = conflictFields(meta, raw);
      return {
        code: 'DATA_DUPLICATE',
        message: `这个值已经被另一条记录占用了${fields.length > 0 ? `（${fields.join('、')}）` : ''}，请改一个或先去重`,
        context: { fields, model: modelName(meta), detail: brief(raw) },
      };
    }
    if (code === 'P2003') {
      return {
        code: 'DATA_STILL_REFERENCED',
        message: '这条数据还被其他数据引用着，删不掉。请先清掉引用它的记录',
        context: { model: modelName(meta), detail: brief(raw) },
      };
    }
    if (code === 'P2025') {
      return {
        code: 'NOT_FOUND',
        message: '要改的记录已经不存在了（可能刚被删掉），请刷新后重试',
        context: { model: modelName(meta), detail: brief(meta?.cause ?? raw) },
      };
    }
    // P2010 = 裸 SQL 失败：真正的分类信息在 meta.code（SQLite 扩展码）里。
    if (code === 'P2010' && sqlite !== null) {
      const decoded = decodeSqliteCode(sqlite, raw, e);
      if (decoded) return decoded;
    }
    // P2021 / P2022 = 模型查询面缺表 / 缺列（实测：`meta.table` 是 `main.groups`，`meta.column` 是列名）。
    // 与裸 SQL 面的 `no such table`（走 P2010+主码 1）是同一件事的两张脸：漏一张就退回 INTERNAL。
    if (code === 'P2021' || code === 'P2022') {
      const isColumn = code === 'P2022';
      const missing = String(isColumn ? (meta?.column ?? meta?.modelName ?? '') : (meta?.table ?? ''))
        .replace(/^main\./, '');
      return {
        code: 'SCHEMA_MISMATCH',
        message: `本地数据库缺少${isColumn ? '字段' : '表'}「${missing || (isColumn ? '未知列' : '未知表')}」，通常是升级后迁移还没跑完。请重启本地服务；仍报错请从备份恢复`,
        context: {
          missing: missing || undefined,
          model: modelName(meta),
          prisma_code: code,
          detail: brief(raw),
        },
      };
    }
    if (code === 'P2024') {
      return storage('STORAGE_LOCKED', '本地数据库连接数已用满，稍后重试。若持续如此请重启本地服务', e);
    }
    if (code === 'P2034') {
      return storage('STORAGE_LOCKED', '本地数据库正在处理另一笔写入（并发冲突），本次没有生效。请重试', e);
    }
    // P2000 值过长 / P2011 空值 / P2012 缺列 / P2013 连接耗尽：
    // 都是「程序写的东西不合 DDL 或连接配置」，属我方缺陷，归内部错误但保留原文。
    if (code === 'P2000' || code === 'P2011' || code === 'P2012' || code === 'P2013') {
      return {
        code: 'INTERNAL',
        message: '本地服务写入的数据不符合表结构，本次改动没有生效',
        context: { prisma_code: code, detail: brief(raw) },
      };
    }
    return internalFallback(e, code);
  }

  // ── Prisma 连接面：打不开库文件（外接盘拔了、目录被删、权限不足）────────────────
  if (name === 'PrismaClientInitializationError') {
    // 实测：`errorCode` / `retryable` 是**挂了名但值为 undefined** 的自有键（Object.keys 里有，
    // JSON.stringify 里没），判据落在它们身上等于永远走兜底。真话只在 message 那句
    // `Error code 14: Unable to open the database file` 里——14 是 SQLite 主码，照它细分。
    const engineCode = Number(/Error code (\d+)/i.exec(e.message ?? '')?.[1]);
    if (Number.isFinite(engineCode) && engineCode !== 0) {
      const decoded = decodeSqliteCode(engineCode, engineLine(e.message), e);
      if (decoded) return decoded;
    }
    return storage(
      'STORAGE_UNAVAILABLE',
      '本地数据库文件打不开：数据目录可能不在可写位置、被移动过，或外接磁盘已拔出。请检查目录后重启本地服务',
      e,
    );
  }
  // ── Prisma：查询形状写错（我们的代码问题，不是用户的）──────────────────────────
  if (name === 'PrismaClientValidationError' || name === 'PrismaClientUnknownRequestError') {
    return {
      code: 'INTERNAL',
      message: '本地服务发出的查询不合法，本次改动没有生效',
      context: { detail: brief(raw) },
    };
  }
  if (name === 'PrismaClientRustPanicError') {
    return storage('STORAGE_CORRUPT', '本地数据库引擎异常，请重启本地服务；若反复出现请从备份恢复', e);
  }

  // ── node:sqlite：迁移执行器 / 备份恢复 / 首启搬迁走的这条道 ────────────────────
  if (code === 'ERR_SQLITE_ERROR' || code.startsWith('SQLITE_')) {
    if (sqlite !== null) {
      const decoded = decodeSqliteCode(sqlite, raw || e.message, e);
      if (decoded) return decoded;
    }
    const text = `${code} ${e.message ?? ''}`;
    if (/CORRUPT|NOTADB|not a database/i.test(text)) {
      return storage('STORAGE_CORRUPT', '本地数据库文件已损坏，无法读写。请从备份恢复，或导出数据后重建', e);
    }
    return internalFallback(e, code);
  }

  // ── 文件系统面：产物落盘、备份导出/恢复走的是 fs， errno 直接决定用户能做什么 ────
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return storage('STORAGE_UNAVAILABLE', '本地数据目录里缺少必要的文件或目录。请检查数据目录是否被移动或清理过，重启本地服务', e);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return storage('STORAGE_READONLY', '本地数据目录当前不可写（权限不足或所在磁盘是只读的）。请检查目录权限后重启本地服务', e);
  }
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return storage('STORAGE_UNAVAILABLE', '磁盘空间不足，本地服务写不进去。请清理磁盘后重试', e);
  }

  // ── 包装层：`new Error('迁移 0021 失败：…', { cause })` 这类只加前缀、不改形状 ────
  // 只看一层 `cause`：递归的 `decodeDataLayerError(cause)` 会自己继续往下找，链长不必在这里循环。
  // 命中的码原样保留，只把外层那句前缀并进 detail，
  // 于是「迁移 0022 失败：… FOREIGN KEY constraint failed」这类仍能读到是哪一棒炸的。
  const cause = e.cause;
  if (depth < 4 && cause instanceof Error && cause !== e) {
    const decoded = decodeDataLayerError(cause, depth + 1);
    if (decoded && decoded.code !== 'INTERNAL') {
      return {
        ...decoded,
        context: {
          ...decoded.context,
          detail: brief(`${engineLine(e.message) || e.message} ← ${String(decoded.context.detail ?? '')}`),
        },
      };
    }
  }

  // ── 其余抛出：不猜语义，只把原文一行带进 detail ────────────────────────────────
  return internalFallback(e, code);
}

/** SQLite 结果码 → 码表。约束类看子类型，环境类看主码。 */
function decodeSqliteCode(sqlite: number, raw: string, error: unknown): DecodedError | null {
  const main = sqlite & 0xff;

  if (main === SQLITE_CONSTRAINT) {
    // 扩展码丢掉子类型时（裸 19）退文案按原文判：实测 `$executeRawUnsafe` 与 node:sqlite
    // 都带扩展码，但 `sqlite3_extended_result_codes` 未开的句柄只会给 19。
    if (SUBTYPE(sqlite) === 0 && /foreign key/i.test(raw)) {
      return {
        code: 'DATA_STILL_REFERENCED',
        message: '这条数据还被其他数据引用着，删不掉。请先清掉引用它的记录',
        context: { detail: brief(raw) },
      };
    }
    switch (SUBTYPE(sqlite)) {
      case FOREIGN_KEY:
        return {
          code: 'DATA_STILL_REFERENCED',
          message: '这条数据还被其他数据引用着，删不掉。请先清掉引用它的记录',
          context: { detail: brief(raw) },
        };
      case UNIQUE:
      case PRIMARY_KEY: {
        const fields = conflictFields(undefined, raw);
        return {
          code: 'DATA_DUPLICATE',
          message: `这个值已经被另一条记录占用了${fields.length > 0 ? `（${fields.join('、')}）` : ''}，请改一个或先去重`,
          context: { fields, detail: brief(raw) },
        };
      }
      case CHECK:
      case NOT_NULL:
      default:
        // CHECK / NOT NULL，以及没有实测样本的 trigger / vtab / rowid / pinned 子类型：
        // 语义都是「程序这次写的形状不合 DDL」，属我方缺陷，不该冒充用户能修的冲突码。
        // 不硬编细分文案，但原文照抄进 detail，界面上折叠区仍查得到。
        return {
          code: 'INTERNAL',
          message: '本地服务写入的数据不符合表结构约束，本次改动没有生效',
          context: { sqlite_code: sqlite, detail: brief(raw) },
        };
    }
  }

  if (main === SQLITE_BUSY || main === SQLITE_LOCKED) {
    return storage('STORAGE_LOCKED', '本地数据库正被另一个进程占用（常见于同时开了两个本地服务）。请稍后重试', error);
  }
  if (main === SQLITE_READONLY || main === SQLITE_PERM) {
    return storage('STORAGE_READONLY', '本地数据库当前不可写（所在磁盘或目录是只读的）。请检查权限后重启本地服务', error);
  }
  if (main === SQLITE_CANTOPEN) {
    return storage(
      'STORAGE_UNAVAILABLE',
      '本地数据库文件打不开：数据目录可能不在可写位置、被移动过，或外接磁盘已拔出。请检查目录后重启本地服务',
      error,
    );
  }
  if (main === SQLITE_FULL) {
    return storage('STORAGE_UNAVAILABLE', '磁盘空间不足，本地数据库写不进去。请清理磁盘后重试', error);
  }
  if (main === SQLITE_CORRUPT || main === SQLITE_NOTADB) {
    return storage('STORAGE_CORRUPT', '本地数据库文件已损坏，无法读写。请从备份恢复，或导出数据后重建', error);
  }
  // 主码 1 = SQLITE_ERROR：迁移没跑完时最常见的是 no such table / no such column。
  if (/no such (table|column)/i.test(raw)) {
    const missing = /no such (table|column):?\s*([\w.]+)/i.exec(raw);
    const isColumn = (missing?.[1] ?? '').toLowerCase() === 'column';
    return {
      code: 'SCHEMA_MISMATCH',
      message: `本地数据库缺少${isColumn ? '字段' : '表'}${missing?.[2] ? `「${missing[2]}」` : ''}，通常是升级后迁移还没跑完。请重启本地服务；仍报错请从备份恢复`,
      context: { missing: missing?.[2], detail: brief(raw) },
    };
  }
  return null;
}

/**
 * 出口用的便捷包装：任意抛出 → `ApiException`（REST 与 MCP 共用同一份状态码表）。
 *
 * 与 `decodeDataLayerError` 的分工：解码器负责「这是什么错」，这里负责「两个出口拿到的
 * 一定是 ApiException」——因此调用方不必再写 `if (!(error instanceof ApiException)) throw`，
 * 那正是旧版把 FK 违规洗成 500 的那一行。永不返回 null：认不出的仍给 `INTERNAL`，
 * 但 `detail` 带原文，`throw '字符串'` 也不丢现场。
 */
export function toApiExceptionFromError(error: unknown, fallbackMessage = '服务内部错误'): ApiException {
  // ApiException 已经带着码与文案（`code` 是字符串，落进下面的解码会被误当成 errno 类形状），
  // 原样交回。调用方因此可以无条件包装，不必先做 `instanceof` 判断。
  if (error instanceof ApiException) return error;
  const decoded = decodeDataLayerError(error);
  if (decoded) return new ApiException(decoded.code, decoded.message, undefined, decoded.context);
  const text = error instanceof Error ? error.message : String(error);
  return new ApiException('INTERNAL', fallbackMessage, undefined, {
    detail: brief(engineLine(text) || text),
  });
}

/** 供测试与文档引用：本模块会产出的码集合（码表同步闸的判据之一）。 */
export const DATA_LAYER_CODES = [
  'DATA_STILL_REFERENCED',
  'DATA_DUPLICATE',
  'SCHEMA_MISMATCH',
  'STORAGE_UNAVAILABLE',
  'STORAGE_LOCKED',
  'STORAGE_CORRUPT',
  'STORAGE_READONLY',
  'NOT_FOUND',
  'INTERNAL',
] as const;
