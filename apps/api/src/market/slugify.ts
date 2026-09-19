/** 发布 slugify：非 ASCII（中文技能名）整体归一为 'skill'，冲突由调用方加后缀。 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}
