/**
 * 6.5 第 5 条的「提交后自动跳到下一条未审核」需要一个跨组件的信号：
 * 审核表单的宿主是 `src/app/overlay-slot.tsx`（三个入口共用，见基座注释），
 * 而「下一条」的候选队列只有审核页知道。抽屉与页面之间没有 props 通道，
 * 所以在 feature 内部留一个绑定口：审核页挂载时登记、卸载时注销，表单提交成功后调用。
 *
 * 不放 `app/store/shell.ts`：那是只读目录，且「队列推进」是审核页的私事。
 */
type Listener = (taskId: string) => void;

let listener: Listener | null = null;

export function bindReviewQueue(next: Listener | null): void {
  listener = next;
}

export function notifyReviewSubmitted(taskId: string): void {
  listener?.(taskId);
}
