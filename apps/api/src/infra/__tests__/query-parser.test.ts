import { describe, expect, it } from 'vitest';
import { QUERY_ARRAY_LIMIT, queryParser } from '../query-parser';

/**
 * D-1（R7 web 面全量回归）：查询串多值参数的解析形状。
 *
 * 判据钉在「数组」而不是「不报错」上：qs 越过 `arrayLimit` 后并不抛，而是把第 21 个值
 * 连同前面的值一起塞进**数字键对象** `{0:'R000', …, 20:'R020'}`。那是个合法 object，
 * 只有 `Array.isArray` 与长度能把它和真数组分开——而下游 `stringListSchema` 只吃
 * `string | string[]`，于是症状表现为 422 `invalid_union`（症状在下游，病根在解析层）。
 */

/** `?requirements[]=R000&requirements[]=R001…`：curl / Agent 面手写的方括号形态。 */
function bracketParams(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `requirements[]=R${String(i).padStart(3, '0')}`,
  ).join('&');
}

/** `?requirements=R000&requirements=R001…`：web `buildQuery` 对数组发的重复键形态。 */
function repeatedParams(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `requirements=R${String(i).padStart(3, '0')}`,
  ).join('&');
}

/** 先断形状再取值：`ParsedQs` 的索引类型是联合，越界项（数字键对象）在这一步就会红。 */
function asList(value: unknown): string[] {
  expect(Array.isArray(value), `应是数组，实际 ${typeof value} ${JSON.stringify(value)}`).toBe(true);
  return value as string[];
}

describe('queryParser 的多值数组边界（D-1）', () => {
  it('限额确实抬过了 qs 默认的 20', () => {
    expect(QUERY_ARRAY_LIMIT).toBeGreaterThan(20);
  });

  it('21 个同名方括号参数解析成数组——默认限额下这里是数字键对象', () => {
    const requirements = asList(queryParser(bracketParams(21)).requirements);
    expect(requirements).toHaveLength(21);
    // 第 21 个（下标 20）正是旧配置的越界项：它进数组了才算修好。
    expect(requirements[20]).toBe('R020');
  });

  it('25 个同名参数同样是完整数组', () => {
    const requirements = asList(queryParser(bracketParams(25)).requirements);
    expect(requirements).toHaveLength(25);
    expect(requirements[24]).toBe('R024');
  });

  it('重复键形态（web 的实际发法）在 21 个时也成数组', () => {
    expect(asList(queryParser(repeatedParams(21)).requirements)).toHaveLength(21);
  });

  it('带与不带前导 ? 的两种入参等价，且 ? 不残留在键名里', () => {
    const bare = queryParser(bracketParams(21));
    const prefixed = queryParser(`?${bracketParams(21)}`);
    expect(prefixed).toEqual(bare);
    // Express 5 传的是 `parseurl` 剥好 `?` 的串，单测/代理层手写的串可能带 `?`：
    // 不忽略前缀就会多出一个 `?requirements` 键，条件被静默丢掉。
    expect(Object.keys(bare)).toEqual(['requirements']);
    expect(Object.keys(prefixed).some((key) => key.startsWith('?'))).toBe(false);
  });

  it('嵌套键仍解析成对象——extended 语义（20.7 的 custom_fields[key]=v）不回归', () => {
    const parsed = queryParser(
      'view=all&custom_fields[severity]=高&custom_fields[platform]=ios&custom_fields[platform]=macos',
    );
    expect(parsed.view).toBe('all');
    expect(parsed.custom_fields).toEqual({ severity: '高', platform: ['ios', 'macos'] });
  });

  it('单值仍给字符串、无查询串给空对象（Express 无 query 时传的是 null）', () => {
    expect(queryParser('view=review').view).toBe('review');
    expect(queryParser(null)).toEqual({});
    expect(queryParser(undefined)).toEqual({});
    expect(queryParser('')).toEqual({});
  });
});
