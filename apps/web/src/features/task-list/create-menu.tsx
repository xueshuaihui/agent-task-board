import { useState } from 'react';
import type { Template } from '@/api/types';
import { CreateMenu } from '@/features/board/toolbar';
import { QuickCreateDialog, type QuickCreateTarget } from '@/features/board/quick-create';
import { useBoardMutations } from '@/features/board/mutations';

/**
 * 原型 3.8 第 795 行：任务列表页头部的 `＋ 新建任务 ▾`——这一列的**唯一**创建入口。
 *
 * 下拉的呈现（空白任务 / 从模板最多 6 条 / 管理模板…）复用 3.4 的 `CreateMenu`：两处是同一份
 * 规格，各自一份 UI 迟早漂。本文件因此只剩「选完之后做什么」这一层：
 * - 弹窗与写操作走看板的 `QuickCreateDialog` + `useBoardMutations`（8.1 的
 *   「create 恒落 BACKLOG，建在待执行 = create → transition 两步」与 422 逐字段回填只有一份）；
 * - 3.8 与 3.4 都落在需求池：列表页不替用户决定「建完就丢给 Agent」，
 *   选中模板时只把 `preset` 递给弹窗（预填不是校验，8.1）。
 *
 * 触发按钮的 `data-testid="create-task"` 由 `CreateMenu` 自己带上：`app.tsx` 的 `PAGES`
 * 一次只挂一页，看板与列表页的入口不会同时出现在 DOM 里，所以同一个 id 够用。
 */
export function CreateTaskMenu() {
  const mutations = useBoardMutations();
  const [quick, setQuick] = useState<QuickCreateTarget | null>(null);

  const openCreate = (template?: Template) =>
    setQuick(template ? { target: 'BACKLOG', preset: template.preset } : { target: 'BACKLOG' });

  return (
    <>
      <CreateMenu onCreate={openCreate} />
      <QuickCreateDialog state={quick} mutations={mutations} onClose={() => setQuick(null)} />
    </>
  );
}
