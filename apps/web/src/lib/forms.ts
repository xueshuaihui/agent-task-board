import type { Dispatch, SetStateAction } from 'react';

/**
 * 表单内联校验错误的清除口径：用户改哪个字段就只清哪个，其余报错保留。
 * 不这么做的话，提交失败后即使把输入框填对了，红字仍挂在字段上，
 * 要到下一次提交才消失——看起来像「填了也没用」。
 */
export function clearFieldError(
  setErrors: Dispatch<SetStateAction<Record<string, string>>>,
  key: string,
): void {
  setErrors((current) => {
    if (!(key in current)) return current;
    const next = { ...current };
    delete next[key];
    return next;
  });
}
