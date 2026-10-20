import { REVIEW_MODE_LABEL } from '@/lib/labels';
import type { ReviewMode } from '@/api/types';

/**
 * #5 Q4：轻确认卡片/编辑弹窗共用的「Agent 请求 vs 实际审核方式」文案判定。
 *
 * 为什么要单列纯函数：web 测试没有 jsdom（同 features/creation/__tests__ 既有口径），
 * 「请求值何时该警告」不能靠组件挂载验收，抽出来给单测直钉。
 *
 * 语义边界：`requested_review_mode` 只是 Agent 的请求，`review_mode` 才是服务端拟用/最终值
 * （用户直选 > Agent 请求 > 全局默认）。请求免审核一律显眼提示——即使拟用值恰好也是 none，
 * 也必须让用户看见「这是 Agent 在要求跳过审核」再亲自确认；请求人工审核只在未被采纳时提示；
 * 相同且为 human 时安静注明「Agent 请求」即可；没有请求 = 不显示任何请求提示。
 */
export type CreationReviewModeNotice =
  | { kind: 'alert'; text: string }
  | { kind: 'quiet'; text: string };

export function creationReviewModeNotice(
  requested: ReviewMode | null | undefined,
  actual: ReviewMode,
): CreationReviewModeNotice | null {
  if (!requested) return null;
  if (requested === 'none') {
    return { kind: 'alert', text: 'Agent 请求免审核，请确认' };
  }
  if (requested === actual) {
    return { kind: 'quiet', text: `审核：${REVIEW_MODE_LABEL[actual]} · Agent 请求` };
  }
  return { kind: 'alert', text: 'Agent 请求人工审核，请确认' };
}
