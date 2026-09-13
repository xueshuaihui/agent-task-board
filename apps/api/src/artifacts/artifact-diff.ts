/**
 * unified diff 解析（6.10.1 的 `diff` 预览）。不引第三方依赖：git 产出的 diff 文本语法有限，
 * 这里按 `@@` 段的行数预算逐行推进——正文预算没耗尽前一律当正文，否则被删掉的那行
 * 文本本身长得像 `--- x` 时会被误判成文件头。行号在服务端算好，前端只管按 type 上色（原型 9.1）。
 */

export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineKind;
  old_line: number | null;
  new_line: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  old_path: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffResult {
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** 认不出来的行：不静默丢弃，前端可提示「部分片段无法解析」。 */
  unparsed_lines: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `a/src/x.ts` / `/dev/null`：前者剥前缀，后者返回 null 表示该侧不存在。 */
function stripSide(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value === '/dev/null') return null;
  const withoutPrefix = value.replace(/^a\//, '').replace(/^b\//, '');
  const tab = withoutPrefix.indexOf('\t');
  return (tab > 0 ? withoutPrefix.slice(0, tab) : withoutPrefix) || null;
}

function gitHeaderPath(rest: string): string {
  const target = rest.split(' ').find((part) => part.startsWith('b/')) ?? '';
  return stripSide(target) ?? target;
}

export function parseUnifiedDiff(text: string): DiffResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: DiffFile[] = [];
  const summary = { additions: 0, deletions: 0, unparsed: 0 };

  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldBudget = 0;
  let newBudget = 0;
  let oldHeader: string | null | undefined;

  const open = (filePath: string): DiffFile => {
    const file: DiffFile = {
      path: filePath,
      old_path: null,
      status: 'modified',
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    files.push(file);
    return file;
  };

  const push = (type: DiffLineKind, text: string, old: number | null, next: number | null): void => {
    hunk!.lines.push({ type, old_line: old, new_line: next, text });
    if (type === 'add') {
      current!.additions += 1;
      summary.additions += 1;
    }
    if (type === 'del') {
      current!.deletions += 1;
      summary.deletions += 1;
    }
  };

  for (const line of lines) {
    const inBody = hunk !== null && (oldBudget > 0 || newBudget > 0);
    if (inBody && !line.startsWith('@@')) {
      const marker = line[0];
      const body = line.slice(1);
      if (marker === '+') {
        push('add', body, null, newLine);
        newLine += 1;
        newBudget -= 1;
        continue;
      }
      if (marker === '-') {
        push('del', body, oldLine, null);
        oldLine += 1;
        oldBudget -= 1;
        continue;
      }
      if (marker === '\\') {
        // `\ No newline at end of file` 属于上一条正文，不占行号也不耗预算。
        continue;
      }
      // 空行是被剥掉尾随空格的上下文行（`"foo"` 而非 `" foo"`），仍要占号，否则后面整体错位。
      push('ctx', marker === undefined ? '' : body, oldLine, newLine);
      oldLine += 1;
      newLine += 1;
      oldBudget -= 1;
      newBudget -= 1;
      continue;
    }

    if (line.startsWith('diff --git ')) {
      current = open(gitHeaderPath(line.slice('diff --git '.length)));
      oldHeader = undefined;
      hunk = null;
      continue;
    }
    if (line.startsWith('new file mode')) {
      if (current) current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode') || line.startsWith('old file mode')) {
      if (current) current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      const from = line.slice('rename from '.length).trim();
      if (!current) current = open(from);
      current.old_path = from;
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      const to = line.slice('rename to '.length).trim();
      if (!current) current = open(to);
      current.path = to;
      current.status = 'renamed';
      continue;
    }
    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files')) {
      if (!current) current = open(stripSide(line.split(' ').pop() ?? '') ?? '');
      current.binary = true;
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('---\t')) {
      oldHeader = stripSide(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('+++\t')) {
      const newHeader = stripSide(line.slice(4));
      if (!current) current = open(newHeader ?? oldHeader ?? '');
      if (newHeader) current.path = newHeader;
      if (oldHeader === null) current.status = 'added';
      else if (newHeader === null) current.status = 'deleted';
      else if (oldHeader && oldHeader !== current.path && current.status === 'modified') {
        current.old_path = oldHeader;
      }
      oldHeader = undefined;
      hunk = null;
      continue;
    }

    const matched = HUNK_RE.exec(line);
    if (matched && current) {
      const oldLines = matched[2] === undefined ? 1 : Number(matched[2]);
      const newLines = matched[4] === undefined ? 1 : Number(matched[4]);
      hunk = {
        header: line,
        old_start: Number(matched[1]),
        old_lines: oldLines,
        new_start: Number(matched[3]),
        new_lines: newLines,
        lines: [],
      };
      current.hunks.push(hunk);
      // `@@ -0,0 +1,3 @@` 的起点 0 表示该侧还没有行，首个真实行号是 1。
      oldLine = hunk.old_start === 0 ? 1 : hunk.old_start;
      newLine = hunk.new_start === 0 ? 1 : hunk.new_start;
      oldBudget = oldLines;
      newBudget = newLines;
      continue;
    }

    if (line.trim() === '' || line.startsWith('index ') || line.startsWith('similarity ') ||
      line.startsWith('dissimilarity ') || line.startsWith('copy ') || line.startsWith('\\')) {
      continue;
    }
    summary.unparsed += 1;
  }

  return {
    files: files.filter((file) => file.path !== '' || file.hunks.length > 0),
    additions: summary.additions,
    deletions: summary.deletions,
    unparsed_lines: summary.unparsed,
  };
}
