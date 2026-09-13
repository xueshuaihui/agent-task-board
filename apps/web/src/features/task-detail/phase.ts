import type { ArtifactType } from '@/api';

/**
 * 6.10.1 的产物预览器阶段开关。
 *
 * 与 `@/lib/phase.ts` 同一套约定：阶段二的能力在阶段一**不渲染**，也不给置灰按钮
 * （原型 4.5「一行一个动作按钮，不在阶段一把按钮置灰——置灰的预览按钮会让人以为是网络问题」）。
 *
 * TODO(主 agent 接线)：`@/lib/phase.ts` 目前只有页面级开关，产物预览这一项先落在 feature 内；
 * 并入基座后这里只改 import 路径，组件不需要动。
 */
export const SHOW_MARKDOWN_PREVIEWER = false;
export const SHOW_JSON_PREVIEWER = false;
export const SHOW_HTML_PREVIEWER = false;
export const SHOW_PDF_PREVIEWER = false;

/** 阶段二才渲染的四类，键即 `artifacts.type` 枚举值。 */
const STAGE_TWO_PREVIEWERS: Record<string, boolean> = {
  markdown: SHOW_MARKDOWN_PREVIEWER,
  json: SHOW_JSON_PREVIEWER,
  html: SHOW_HTML_PREVIEWER,
  pdf: SHOW_PDF_PREVIEWER,
};

/** 6.10.1 第一行到第四行：diff / image / text / log 恒定在阶段一。 */
const ALWAYS_PREVIEWABLE: readonly ArtifactType[] = ['diff', 'image', 'text', 'log'];

export function previewableArtifactTypes(): ArtifactType[] {
  const unlocked = Object.entries(STAGE_TWO_PREVIEWERS)
    .filter(([, enabled]) => enabled)
    .map(([type]) => type as ArtifactType);
  return [...ALWAYS_PREVIEWABLE, ...unlocked];
}

/** `link` 不是「预览器」，它走系统浏览器（6.10.1 末段），所以单独判。 */
export function hasPreviewer(type: string): boolean {
  return previewableArtifactTypes().some((item) => item === type);
}
