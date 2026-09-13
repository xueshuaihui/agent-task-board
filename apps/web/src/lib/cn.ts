import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind 类合并：条件类用 clsx，冲突类（同一工具类不同值）由 tailwind-merge 收敛。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
