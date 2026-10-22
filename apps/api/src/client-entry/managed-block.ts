import {
  CLIENT_ENTRY_MARKER_BEGIN,
  CLIENT_ENTRY_MARKER_END,
} from '../contract/client-entry';

/**
 * 托管块是「用户文件里的一小段我方内容」：标记对之外的字节永远不归本应用管。
 * 这里全部是纯函数（不碰 fs），installer 才能先用 plan 预览、再决定是否落盘。
 */

export type ManagedBlockRead =
  | { kind: 'absent' }
  | { kind: 'found'; body: string; start: number; end: number }
  | { kind: 'unpaired' };

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 只去掉标记边界上的一个换行；块内正文的 EOL 由 readManagedBlock 统一折成 LF。 */
function trimBoundaryNewlines(raw: string): string {
  let body = raw;
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\r\n')) body = body.slice(0, -2);
  else if (body.endsWith('\n')) body = body.slice(0, -1);
  return body;
}

function buildBlock(body: string, eol: '\n' | '\r\n'): string {
  // body 的逻辑值是 LF（模板与哈希都用 LF）；落盘时按文件主导 EOL 展开，
  // 读回时再折回 LF——否则同一份模板在 CRLF 文件里的 content_hash 会不同。
  const normalized = body.replace(/\r\n/g, '\n');
  const rendered = eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
  return `${CLIENT_ENTRY_MARKER_BEGIN}${eol}${rendered}${eol}${CLIENT_ENTRY_MARKER_END}`;
}

/**
 * `start` 是 BEGIN 标记的起点，`end` 是 END 标记之后的第一个字符下标——
 * `text.slice(start, end)` 就是整块（含标记），strip/merge 直接用它替换。
 * `body` 的逻辑值是 LF：读的时候把 CRLF 折成 LF，保证同一模板在不同 EOL 文件里哈希一致。
 */
export function readManagedBlock(text: string): ManagedBlockRead {
  const beginIndex = text.indexOf(CLIENT_ENTRY_MARKER_BEGIN);
  const endIndex = text.indexOf(CLIENT_ENTRY_MARKER_END);
  const beginCount = countOccurrences(text, CLIENT_ENTRY_MARKER_BEGIN);
  const endCount = countOccurrences(text, CLIENT_ENTRY_MARKER_END);

  if (beginCount === 0 && endCount === 0) return { kind: 'absent' };
  // 多一对、少一半、END 在前，都无法判断哪一段才是「我们的」内容。
  if (beginCount !== 1 || endCount !== 1 || beginIndex > endIndex) return { kind: 'unpaired' };

  const raw = text.slice(beginIndex + CLIENT_ENTRY_MARKER_BEGIN.length, endIndex);
  return {
    kind: 'found',
    body: trimBoundaryNewlines(raw).replace(/\r\n/g, '\n'),
    start: beginIndex,
    end: endIndex + CLIENT_ENTRY_MARKER_END.length,
  };
}

/** 取文件中出现次数更多的换行；空文件与纯 LF 都回 `\n`。 */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > 0 && crlf * 2 > lf ? '\r\n' : '\n';
}

/**
 * 追加时与已有内容之间固定隔一个空行（两个换行符）：文件本身结尾已有换行的，
 * 只补一个；没有的补两个。不能先 trim 用户内容，否则「块外逐字保留」就破了。
 */
export function mergeManagedBlock(
  text: string,
  body: string,
): { kind: 'ok'; text: string; action: 'insert' | 'update' | 'unchanged' } | { kind: 'unpaired' } {
  const read = readManagedBlock(text);
  if (read.kind === 'unpaired') return { kind: 'unpaired' };

  const eol = detectEol(text);
  if (read.kind === 'found') {
    const normalizedBody = body.replace(/\r\n/g, '\n');
    if (read.body === normalizedBody) return { kind: 'ok', text, action: 'unchanged' };
    const next = text.slice(0, read.start) + buildBlock(normalizedBody, eol) + text.slice(read.end);
    return { kind: 'ok', text: next, action: 'update' };
  }

  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const content = text.slice(bom.length);
  const block = buildBlock(body, eol);
  if (content === '') {
    return { kind: 'ok', text: bom + block + eol, action: 'insert' };
  }
  const separator = content.endsWith('\n') ? eol : eol + eol;
  return { kind: 'ok', text: bom + content + separator + block + eol, action: 'insert' };
}

function countBreaks(run: string): number {
  return (run.match(/\r\n|\n/g) ?? []).length;
}

/**
 * 摘除后只清理「标记行本身」留下的空行：块外非空内容一个字都不动。
 * 两侧都还有内容时，原来贴着的保持贴着，原来有空行的保留一个空行；
 * 只有一侧有内容时，去掉接缝处全部换行（块在文件末尾则留一个终止换行）。
 */
export function stripManagedBlock(
  text: string,
): { kind: 'ok'; text: string; removed: boolean } | { kind: 'unpaired' } {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const core = text.slice(bom.length);
  const read = readManagedBlock(core);
  if (read.kind === 'absent') return { kind: 'ok', text, removed: false };
  if (read.kind === 'unpaired') return { kind: 'unpaired' };

  const before = core.slice(0, read.start);
  const after = core.slice(read.end);
  const trailing = /(?:\r\n|\n)+$/.exec(before)?.[0] ?? '';
  const leading = /^(?:\r\n|\n)+/.exec(after)?.[0] ?? '';
  const beforeCore = before.slice(0, before.length - trailing.length);
  const afterCore = after.slice(leading.length);
  const eol = detectEol(core);

  let joined: string;
  if (beforeCore === '' && afterCore === '') {
    joined = '';
  } else if (beforeCore === '') {
    joined = afterCore;
  } else if (afterCore === '') {
    joined = beforeCore + (trailing === '' ? '' : eol);
  } else {
    const beforeBreaks = countBreaks(trailing);
    const afterBreaks = countBreaks(leading);
    const breaks = beforeBreaks === 0 && afterBreaks === 0
      ? 0
      : beforeBreaks >= 2 || afterBreaks >= 2
        ? 2
        : 1;
    joined = beforeCore + eol.repeat(breaks) + afterCore;
  }

  return { kind: 'ok', text: bom + joined, removed: true };
}
