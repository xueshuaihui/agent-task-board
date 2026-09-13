/**
 * 3.8：`page_size` 可选 50/100/200，**选中值存本地偏好、不进 settings**。
 *
 * 不放 `app/store` 也不进 20.9 的 settings 键总表：这是每台机器自己的窗口偏好，
 * 而 `settings` 会随备份恢复与导入导出走（6.12），把 UI 偏好混进去等于给用户多一个迁移面。
 */
const KEY = 'atb.tasks.pageSize';

export const PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

/** 上限 200 是服务端 `listQuerySchema` 的硬约束（13 章），越界值一律退回默认。 */
export function readPageSize(): number {
  const stored = safeGet();
  const parsed = Number(stored);
  return (PAGE_SIZES as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

export function rememberPageSize(size: number): void {
  if (!(PAGE_SIZES as readonly number[]).includes(size)) return;
  try {
    window.localStorage.setItem(KEY, String(size));
  } catch {
    // 隐私模式 / 配额满：偏好丢了不影响正确性，下一次仍按默认 50 走。
  }
}

function safeGet(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
