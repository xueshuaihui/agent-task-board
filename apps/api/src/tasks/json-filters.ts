import { Prisma } from '@prisma/client';
import { FIELD_KEY_RE, type CustomFieldFilter } from '../contract/schemas';

/**
 * `tags` 与 `custom_fields` 在库里是 JSON 文本列，筛选只能借 SQLite 的 `json_each` 求值。
 * 看板把它直接拼进 `WHERE`，列表页先用它取候选 id 再和其余条件求交——两处共用一份谓词，
 * 避免「同一筛选在看板与列表页结果不一致」。谓词里的任务表别名固定为 `t`。
 */
export function jsonFilterParts(
  tags: string[] | undefined,
  customFields: CustomFieldFilter | undefined,
): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (tags?.length) parts.push(Prisma.sql`(${Prisma.join(tags.map(tagPredicate), ' OR ')})`);

  for (const [key, values] of Object.entries(customFields ?? {})) {
    if (values.length === 0 || !FIELD_KEY_RE.test(key)) continue;
    parts.push(Prisma.sql`(${Prisma.join(values.map((value) => customFieldPredicate(key, value)), ' OR ')})`);
  }
  return parts;
}

/** 多标签之间是 OR：面板里同一分组勾选 3 个标签的语义是「任一命中」。 */
export function tagPredicate(tag: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM json_each(COALESCE(NULLIF(t.tags, ''), '[]')) j WHERE j.value = ${tag})`;
}

/**
 * 单个 `custom_fields[key]=value` 条件。查询串只有文本，而库里 `bool` 存 JSON 布尔、
 * `number` 存裸数字、`multiselect` 存数组，所以先把元素统一降成文本再比：
 * `json_each` 会把 `true`/`false` 返回成整数 1/0，因此这两类取 `e.type`（'true'/'false'），
 * 其余取 `CAST(e.value AS TEXT)`；查询侧再给布尔补 `1`/`0` 写法，两种拼法都能命中。
 * 数组值展平一层，让 `multiselect` 与单值字段共用一条谓词——这一步必须包在 CASE 里，
 * 直接 `json_each(标量文本)` 会让整条查询以 `malformed JSON` 失败。
 *
 * 未登记或已停用的 key 匹配不到任何行（写入侧 20.10 已挡住），因此该条件是「筛出空集」
 * 而不是被忽略——忽略等于多返回一批任务。
 */
export function customFieldPredicate(key: string, value: string): Prisma.Sql {
  const candidates = [value];
  if (value === 'true') candidates.push('1');
  if (value === 'false') candidates.push('0');
  if (value === '1') candidates.push('true');
  if (value === '0') candidates.push('false');
  const inList = Prisma.join(candidates);
  const asText = Prisma.sql`CASE WHEN e.type = 'true' THEN 'true'
         WHEN e.type = 'false' THEN 'false'
         ELSE CAST(e.value AS TEXT) END`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM json_each(COALESCE(NULLIF(t.custom_fields, ''), '{}')) e
    WHERE e.key = ${key}
      AND (${asText} IN (${inList})
        OR CASE WHEN e.type = 'array' THEN EXISTS (
             SELECT 1 FROM json_each(e.value) av WHERE CAST(av.value AS TEXT) IN (${inList})
           ) ELSE 0 END)
  )`;
}
