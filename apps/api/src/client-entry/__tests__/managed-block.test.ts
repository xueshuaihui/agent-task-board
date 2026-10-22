import { describe, expect, it } from 'vitest';
import {
  CLIENT_ENTRY_MARKER_BEGIN as BEGIN,
  CLIENT_ENTRY_MARKER_END as END,
} from '../../contract/client-entry';
import {
  detectEol,
  mergeManagedBlock,
  readManagedBlock,
  stripManagedBlock,
} from '../managed-block';

function block(body: string, eol: '\n' | '\r\n' = '\n'): string {
  const rendered = eol === '\n' ? body : body.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return `${BEGIN}${eol}${rendered}${eol}${END}`;
}

describe('readManagedBlock', () => {
  it('没有标记时返回 absent', () => {
    expect(readManagedBlock('')).toEqual({ kind: 'absent' });
    expect(readManagedBlock('# 用户自己的内容\n')).toEqual({ kind: 'absent' });
    expect(readManagedBlock('jarvis-workbench 只是普通文本')).toEqual({ kind: 'absent' });
  });

  it('找到成对标记时返回正文与整块区间', () => {
    const text = `before\n${block('hello')}\nafter\n`;
    const read = readManagedBlock(text);
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('expected found');
    expect(read.body).toBe('hello');
    expect(read.start).toBe(text.indexOf(BEGIN));
    expect(read.end).toBe(text.indexOf(END) + END.length);
    expect(text.slice(read.start, read.end)).toBe(block('hello'));
  });

  it('去掉标记两侧各一个换行，块内换行原样保留', () => {
    const read = readManagedBlock(block('line1\nline2'));
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('expected found');
    expect(read.body).toBe('line1\nline2');
  });

  it('body 的逻辑值统一为 LF：同一模板在 LF/CRLF 文件里哈希一致', () => {
    const lf = readManagedBlock(block('line1\nline2', '\n'));
    const crlf = readManagedBlock(block('line1\nline2', '\r\n'));
    expect(lf.kind).toBe('found');
    expect(crlf.kind).toBe('found');
    if (lf.kind !== 'found' || crlf.kind !== 'found') throw new Error('expected found');
    expect(lf.body).toBe('line1\nline2');
    expect(crlf.body).toBe(lf.body);
  });

  it('空正文返回空串', () => {
    const read = readManagedBlock(`${BEGIN}\n${END}`);
    expect(read.kind).toBe('found');
    if (read.kind !== 'found') throw new Error('expected found');
    expect(read.body).toBe('');
  });

  it.each([
    ['只有 begin', `${BEGIN}\nbody`],
    ['只有 end', `body\n${END}`],
    ['end 在 begin 前', `${END}\nbody\n${BEGIN}`],
    ['两对标记', `${block('a')}\n${block('b')}`],
    ['重复的 begin', `${BEGIN}\n${BEGIN}\nbody\n${END}`],
  ])('%s → unpaired', (_name, text) => {
    expect(readManagedBlock(text)).toEqual({ kind: 'unpaired' });
  });
});

describe('detectEol', () => {
  it('空文件与纯 LF 返回 LF', () => {
    expect(detectEol('')).toBe('\n');
    expect(detectEol('a\nb\n')).toBe('\n');
  });

  it('CRLF 占多数时返回 CRLF', () => {
    expect(detectEol('a\r\nb\r\n')).toBe('\r\n');
    expect(detectEol('a\r\nb\r\nc\nd')).toBe('\r\n');
    expect(detectEol('a\r\nb\nc\nd')).toBe('\n');
  });
});

describe('mergeManagedBlock', () => {
  it('空文件插入：没有多余前导空行', () => {
    const merged = mergeManagedBlock('', 'hello');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.action).toBe('insert');
    expect(merged.text).toBe(`${block('hello')}\n`);
    expect(readManagedBlock(merged.text)).toMatchObject({ kind: 'found', body: 'hello' });
  });

  it('非空文件插入：与原文之间隔一个空行，原文逐字保留', () => {
    const merged = mergeManagedBlock('hello\nworld', 'body');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.action).toBe('insert');
    expect(merged.text).toBe(`hello\nworld\n\n${block('body')}\n`);
  });

  it('原文已以换行结尾时只补一个换行', () => {
    const merged = mergeManagedBlock('hello\n', 'body');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.text).toBe(`hello\n\n${block('body')}\n`);
  });

  it('保留 BOM，且 BOM-only 文件不产生前导空行', () => {
    const merged = mergeManagedBlock('\uFEFF', 'body');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.text).toBe(`\uFEFF${block('body')}\n`);
  });

  it('已存在且正文相同 → unchanged，原文不动', () => {
    const text = `head\n${block('same')}\ntail\n`;
    expect(mergeManagedBlock(text, 'same')).toEqual({
      kind: 'ok',
      text,
      action: 'unchanged',
    });
  });

  it('已存在且正文不同 → 只替换标记对及块内内容', () => {
    const text = `head\n${block('old')}\ntail\n`;
    const merged = mergeManagedBlock(text, 'new');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.action).toBe('update');
    expect(merged.text).toBe(`head\n${block('new')}\ntail\n`);
  });

  it('CRLF 文件的新块使用 CRLF（含块内正文），块外字节不变', () => {
    const text = `head\r\n${block('old\nsecond', '\r\n')}\r\ntail\r\n`;
    const merged = mergeManagedBlock(text, 'new\nsecond');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.text.startsWith('head\r\n')).toBe(true);
    expect(merged.text.endsWith('\r\ntail\r\n')).toBe(true);
    expect(merged.text).toContain(block('new\nsecond', '\r\n'));
    expect(merged.text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('向 CRLF 文件插入多行块时整体使用 CRLF', () => {
    const merged = mergeManagedBlock('user\r\n', 'line1\nline2');
    expect(merged.kind).toBe('ok');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(merged.text).toContain(block('line1\nline2', '\r\n'));
    expect(merged.text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('标记不成对时拒绝合并', () => {
    expect(mergeManagedBlock(`${BEGIN}\nold`, 'new')).toEqual({ kind: 'unpaired' });
    expect(mergeManagedBlock(`${block('a')}\n${block('b')}`, 'new')).toEqual({ kind: 'unpaired' });
  });

  it('再次合并同一正文是幂等的', () => {
    const first = mergeManagedBlock('', 'body');
    if (first.kind !== 'ok') throw new Error('expected ok');
    const second = mergeManagedBlock(first.text, 'body');
    expect(second).toEqual({ kind: 'ok', text: first.text, action: 'unchanged' });
  });
});

describe('stripManagedBlock', () => {
  it('没有块时返回 removed:false，原文不动', () => {
    expect(stripManagedBlock('hello\n')).toEqual({
      kind: 'ok',
      text: 'hello\n',
      removed: false,
    });
  });

  it('只含块的文件摘除后为空串', () => {
    for (const text of [block('body'), `${block('body')}\n`]) {
      expect(stripManagedBlock(text)).toEqual({ kind: 'ok', text: '', removed: true });
    }
  });

  it('摘除追加的块后恢复原文（保留一个终止换行）', () => {
    const merged = mergeManagedBlock('hello\nworld', 'body');
    if (merged.kind !== 'ok') throw new Error('expected ok');
    expect(stripManagedBlock(merged.text)).toEqual({
      kind: 'ok',
      text: 'hello\nworld\n',
      removed: true,
    });

    const withTrailing = mergeManagedBlock('hello\n', 'body');
    if (withTrailing.kind !== 'ok') throw new Error('expected ok');
    expect(stripManagedBlock(withTrailing.text)).toEqual({
      kind: 'ok',
      text: 'hello\n',
      removed: true,
    });
  });

  it('块在文件开头：去掉接缝空行，用户内容不动', () => {
    expect(stripManagedBlock(`${block('body')}\n# User\n`)).toEqual({
      kind: 'ok',
      text: '# User\n',
      removed: true,
    });
  });

  it('块在文件末尾：清掉多余空行，只留一个终止换行', () => {
    expect(stripManagedBlock(`# User\n\n${block('body')}`)).toEqual({
      kind: 'ok',
      text: '# User\n',
      removed: true,
    });
  });

  it('块在中间：保留一个空行，两侧内容逐字保留', () => {
    const text = `# A\n\n${block('body')}\n\n# B\n`;
    expect(stripManagedBlock(text)).toEqual({
      kind: 'ok',
      text: '# A\n\n# B\n',
      removed: true,
    });
  });

  it('块与用户内容贴在一起时不会被强行插入空行', () => {
    expect(stripManagedBlock(`# A\n${block('body')}\n# B\n`)).toEqual({
      kind: 'ok',
      text: '# A\n# B\n',
      removed: true,
    });
    expect(stripManagedBlock(`# A ${block('body')} # B`)).toEqual({
      kind: 'ok',
      text: '# A  # B',
      removed: true,
    });
  });

  it('保留 BOM 与 CRLF', () => {
    const text = `\uFEFF# A\r\n\r\n${block('body', '\r\n')}\r\n`;
    expect(stripManagedBlock(text)).toEqual({
      kind: 'ok',
      text: '\uFEFF# A\r\n',
      removed: true,
    });
  });

  it('不成对时返回 unpaired', () => {
    expect(stripManagedBlock(`${BEGIN}\nbody`)).toEqual({ kind: 'unpaired' });
    expect(stripManagedBlock(`${block('a')}\n${block('b')}`)).toEqual({ kind: 'unpaired' });
  });
});
