import qs from 'qs';
import type { ParsedQs } from 'qs';

/**
 * D-1（R7 web 面全量回归）：查询串多值参数的 `arrayLimit` 抬高值。
 *
 * qs 的默认 `arrayLimit` 是 20——第 21 个同名键的下标 20 越过限额后，qs 不再产出数组，
 * 而是退化成**数字键对象** `{0:'a', …, 20:'g'}`。`contract/schemas.ts` 的 `stringListSchema`
 * 只吃 `string | string[]`，于是 21 个 `?requirements[]=R000…R020`（或等价的重复键
 * `?requirements=R000…R020`，web 的 `buildQuery` 发的就是重复键）在 422 上撞成
 * `invalid_union`，而 20 个恰好全绿——边界是条暗坑，不是容量设计。
 *
 * 取 1000：覆盖「整屏筛完」这类真实筛选面（一期需求数远小于此），同时给 qs 的递归展开留余量。
 * 抬限额不等于全局放行——契约层该卡数的还是卡着：`listQuerySchema.page_size` 上限 200、
 * `batchIdsSchema` 的 `max(200)`、`customFieldFilterSchema` 最多 10 个键。
 * `board`/`tasks` 的 `requirements` / `groups` / `tags` 这类维**没有**条数上限
 * （`tasks.service` 的 `inListPredicate` 把值逐个绑成占位符），本模块只是让它们真的能长成数组。
 */
export const QUERY_ARRAY_LIMIT = 1000;

/**
 * Express `query parser` 选项用的解析函数：入参是**原始查询串**，返回键值对象。
 *
 * 依赖取舍：`qs` 不是本包声明的直接依赖，取的是 express 自带的同源传递依赖——
 * Express 的 `'extended'` 内部就是 `qs.parse(str, { allowPrototypes: true })`
 * （见 `node_modules/express/lib/utils.js` 的 `parseExtendedQueryString`），
 * 用同一个包才能保证除了 `arrayLimit` 之外没有任何解析行为漂移。
 * `@types/qs` 同样已在根 `node_modules` 就位（同为 express 的传递依赖）。
 *
 * 与 `'extended'` 的行为差异只有一处（`arrayLimit`），另加一条防御性保险：
 * - `arrayLimit: QUERY_ARRAY_LIMIT`——本模块存在的理由；
 * - `ignoreQueryPrefix: true`——Express 5 传进来的串本身不带前导 `?`（`parseurl` 的 `.query`
 *   成员就已经剥掉了），所以生产路径上它是无副作用的保险；但代理层与手写串可能带 `?`，
 *   不忽略就会多出一个 `?requirements` 键、把条件静默丢掉。
 * - `allowPrototypes: true` 逐字照抄 extended（qs 6.16 对 `__proto__` 键两种配置都不收，
 *   实测不构成新的污染面），免得顺带改出别的解析行为差异。
 * - 无查询串时 Express 传的是 `null`，与 extended 一样落到 `{}`（qs 对非字符串入参返回空对象）。
 */
export function queryParser(query: string | null | undefined): ParsedQs {
  return qs.parse(typeof query === 'string' ? query : '', {
    arrayLimit: QUERY_ARRAY_LIMIT,
    allowPrototypes: true,
    ignoreQueryPrefix: true,
  });
}
