import type { GroupDimensionKey } from '@/features/board/grouping/dimensions';

/**
 * B15-③：列表页分节维度的本地偏好。原先它寄生在看板过滤偏好（slotA）里，
 * 而过滤统一到「筛选弹层」后没有任何入口能改 slotA —— 分节是本页自己的显示
 * 设置，就该存在本页的键上（同一先例见 `page-pref.ts`：不进 settings、不跟账号走）。
 */
const KEY = 'atb.tasks.groupBy';

const VALID: readonly string[] = ['none', 'group', 'requirement', 'type', 'priority', 'agent', 'tag', 'status'];

export function readGroupBy(): GroupDimensionKey {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(KEY);
  } catch {
    return 'none';
  }
  return stored && VALID.includes(stored) ? (stored as GroupDimensionKey) : 'none';
}

export function rememberGroupBy(dimension: GroupDimensionKey): void {
  try {
    window.localStorage.setItem(KEY, dimension);
  } catch {
    // 隐私模式写不进去：分节退回内存态即可，不值得打扰用户。
  }
}
