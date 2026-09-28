import { Field, Select } from '@/components/ui';
import { REVIEW_MODE_LABEL } from '@/lib/labels';
import type { ReviewMode } from '@/api/types';

/** 建单表单的取值：`''` = 不传 `review_mode`，由服务端 `resolveReviewMode` 吃全局默认键。 */
export type ReviewModeChoice = '' | ReviewMode;

export const REVIEW_MODE_CHOICES: ReviewMode[] = ['human', 'auto', 'none'];

/**
 * 「审核方式」选择器——建单弹窗 / 看板快速新建 / 详情编辑三处共用一份。
 *
 * 为什么默认项是「跟随全局默认」而不是直接选中「人工审核」：0020 §3.5 拍板三条建单路
 * 共用 `default_review_mode` 这一个口径来源，前端替用户写死 human 就等于把全局设置
 * 架空成只对某一条路生效。编辑态没有这一项（行里已存具体值，回落会改写数据）。
 */
export function ReviewModeField({
  value,
  onChange,
  allowDefault,
  globalDefault,
  error,
}: {
  value: ReviewModeChoice;
  onChange: (next: ReviewModeChoice) => void;
  /** 建单态 true（可选「跟随全局默认」），编辑态 false。 */
  allowDefault: boolean;
  /** 设置页当前的 `default_review_mode`，用来把「跟随默认」显示成具体文案。 */
  globalDefault?: ReviewMode;
  error?: string;
}) {
  const defaultLabel = globalDefault ? REVIEW_MODE_LABEL[globalDefault] : '全局默认';
  return (
    <Field
      label="审核方式"
      hint={
        allowDefault
          ? `「等 Agent 审」由你自己起的 Agent Token 领取审核，拿不准时它会转回人工；免审核的任务执行完直接落已完成`
          : `改这里只影响本任务；新任务仍按设置页的默认值（当前：${defaultLabel}）`
      }
      error={error}
    >
      <Select
        value={value}
        options={[
          ...(allowDefault
            ? [{ value: '', label: globalDefault ? `跟随全局默认（${defaultLabel}）` : '跟随全局默认' }]
            : []),
          ...REVIEW_MODE_CHOICES.map((mode) => ({ value: mode, label: REVIEW_MODE_LABEL[mode] })),
        ]}
        onChange={(event) => onChange(event.target.value as ReviewModeChoice)}
      />
    </Field>
  );
}

/** 提交前把选择器取值折成请求体字段：`''` 一律不发（交服务端回落全局默认）。 */
export function reviewModeBody(choice: ReviewModeChoice): { review_mode?: ReviewMode } {
  return choice === '' ? {} : { review_mode: choice };
}
