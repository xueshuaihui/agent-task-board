import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 闸：列表三态必须可辨——查询失败不许渲染成「空」。
 *
 * 病灶（2026-09-29 浏览器走查 + curl 实测）：`api_tokens` 表缺失时 `GET /tokens` 回
 * 500 `SCHEMA_MISMATCH`，Token Tab 却照旧摆「还没有 Token。生成一个后…」——界面只取
 * `tokens.data?.items ?? []`，从没看过 `tokens.error`。同类区域按「报一个点=修整片同类
 * 区域」全片扫过一遍（设置页 + 看板/详情/拆解/技能），这条闸负责防止它再退化。
 *
 * 判据（源码级；本仓无 jsdom，沿用「读源码 + 字符串断言」的House style）：
 * 一个 `.tsx` 里凡把查询结果**折叠成空值**的取数表达式
 * （`X.data?.items ?? []` / `(X.data ?? []).…` / `X.data?.total ?? 0`），
 * 同文件必须看得见那个查询的失败——`X.error` 或 `X.isError` 至少出现一次。
 *
 * 为什么要配「豁免行」：少数取数确实不该有错误面（纯派生、或失败已由上游整块错误面承担），
 * 那就写成 `// 三态豁免：<理由>`——**必须带理由**，光留标记不写原因不算。
 */

const SRC = path.resolve(process.cwd(), 'src');

const tsxFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...tsxFiles(full));
    } else if (name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out.sort();
};

/**
 * 查询绑定：`const tokens = useTokens()`、`const pages = useRunLogPages(…)`。
 * React 自带的那几个**不是**查询钩子（`const rows = useMemo(() => list.data?.items ?? [], …)`
 * 是派生值，真正的查询 `list` 会由它自己那行被抓出来），一律排除，否则闸会指到派生变量上。
 */
const NON_QUERY_HOOKS = new Set([
  'useMemo',
  'useCallback',
  'useEffect',
  'useLayoutEffect',
  'useRef',
  'useState',
  'useReducer',
  'useContext',
  'useId',
  'useTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'useDebugValue',
  'useActionState',
]);

const QUERY_BIND = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(use[A-Z\w$]*)\(/g;

/** 取数被折叠成空值：空数组、0、破折号占位。 */
const foldPattern = (name: string) =>
  new RegExp(
    `${name}(?:\\.data)?\\s*[^\\n]{0,48}?\\?\\?\\s*(?:\\[\\s*\\]|0\\b|'—'|"—")`,
  );

/** 折叠行的上一行写了解释性豁免，就放过这一处。 */
const WAIVER = /\/\/\s*三态豁免：\s*\S/;

interface Offender {
  file: string;
  query: string;
  line: string;
}

const collect = () => {
  const files = tsxFiles(SRC);
  const offenders: Offender[] = [];
  let foldedSites = 0;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const queries = new Set<string>();
    for (const line of lines) {
      for (const match of line.matchAll(QUERY_BIND)) {
        if (!NON_QUERY_HOOKS.has(match[2])) queries.add(match[1]);
      }
      // 解构形式：`const { data: items, error } = useX()`，只登记**没取 error** 的 data 别名。
      for (const match of line.matchAll(/\bconst\s+\{([^}]*)\}\s*=\s*(?:await\s+)?use[A-Z\w$]*\(/g)) {
        if (!/\bdata\b/.test(match[1]) || /\berror\b|isError/.test(match[1])) continue;
        const alias = /data\s*:\s*([A-Za-z_$][\w$]*)/.exec(match[1])?.[1];
        if (alias) queries.add(alias);
      }
    }

    for (const name of queries) {
      const foldedAt = lines.findIndex(
        (line, index) =>
          foldPattern(name).test(line) && !WAIVER.test(lines[index - 1] ?? '') && !WAIVER.test(line),
      );
      if (foldedAt < 0) continue;
      foldedSites += 1;
      if (source.includes(`${name}.error`) || source.includes(`${name}.isError`)) continue;
      offenders.push({
        file: path.relative(SRC, file),
        query: name,
        line: lines[foldedAt].trim().slice(0, 96),
      });
    }
  }
  return { files, offenders, foldedSites };
};

const scanned = collect();

describe('列表三态：查询失败不许渲染成「空」', () => {
  it('扫到了足量的 .tsx（闸本身不是空跑）', () => {
    expect(scanned.files.length).toBeGreaterThan(120);
  });

  it('判据真的在匹配取数折叠（不是恒真的空集合）', () => {
    expect(scanned.foldedSites).toBeGreaterThan(20);
  });

  it('每处折叠空值的取数都看得见自己查询的失败', () => {
    const report = scanned.offenders.map((o) => `${o.file} · ${o.query} · ${o.line}`).join('\n');
    expect(scanned.offenders, report).toEqual([]);
  });

  it('反证：抽掉 tokens.tsx 的列表错误消费就该被判据抓住', () => {
    const file = path.join(SRC, 'features/settings/tabs/tokens.tsx');
    // 换成不含 `tokens.` 的标识符：留着前缀的话 `includes('tokens.error')` 会命中替换后的串，
    // 反证就成了自证。
    const stripped = readFileSync(file, 'utf8').replace(/\btokens\.(error|isError)\b/g, 'void 0');
    const lines = stripped.split('\n');
    const hasFold = lines.some((line) => foldPattern('tokens').test(line) && !WAIVER.test(line));
    const consumes = stripped.includes('tokens.error') || stripped.includes('tokens.isError');
    expect(hasFold).toBe(true);
    expect(consumes).toBe(false);
  });

  it('豁免必须带理由（只留标记不写原因不算豁免）', () => {
    expect(WAIVER.test('// 三态豁免：')).toBe(false);
    expect(WAIVER.test('// 三态豁免：失败已由上游整块错误面承担')).toBe(true);
  });
});
