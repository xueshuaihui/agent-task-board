import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Tailwind 类合并：条件类用 clsx，冲突类（同一工具类不同值）由 tailwind-merge 收敛。
 *
 * ⚠️ 必须把 DESIGN.md §1 的自定义 token 喂给 tailwind-merge，否则它按默认词表分类：
 * `text-body`/`text-badge` 这类自定义**字号**档会被误判进「文字颜色」组，与 variant 里的
 * `text-text-inverse` 等颜色类判成同组冲突、后者被删——按钮/徽章文字色丢失、继承正文黑
 * （2026-09-18 线上症状：浅色模式「新建任务」渐变按钮字体变黑）。字号、颜色两组各自登记后，
 * 同组冲突只在同类之间收敛，跨组不再误伤。
 */
const twMergeWithTokens = extendTailwindMerge({
  extend: {
    classGroups: {
      // 自定义字号档（globals.css --text-*）：text-page-title / text-section-title / …
      'font-size': [
        {
          text: [
            'page-title',
            'section-title',
            'card-title',
            'body',
            'aux',
            'code',
            'nav',
            'logo',
            'badge',
          ],
        },
      ],
      // 自定义文字颜色（--color-text-*）：text-text-primary / text-text-secondary / …
      'text-color': [
        { text: ['text-primary', 'text-secondary', 'text-tertiary', 'text-inverse'] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMergeWithTokens(clsx(inputs));
}
