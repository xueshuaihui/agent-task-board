/**
 * 0919 五章：分组（任务的顶层容器）。字段与后端 `apps/api/src/groups/groups.service.ts`
 * 的 `GroupDto` 同名同口径——此处是前端唯一出处，feature 内不要重复声明。
 */

/**
 * §5.5：活跃分组数量上限。与后端 `GROUP_LIMIT`（`apps/api/src/groups/groups.service.ts`）
 * 同值，纯前端只用于提前置灰「新建分组」；真正的拒绝由服务端返回 409
 * `GROUP_LIMIT_REACHED`（见 `api/errors.ts` 文案）。
 */
export const GROUP_LIMIT = 50;

export interface Group {
  id: string;
  name: string;
  /** 16 进制色值（新建/编辑时从状态色 token 调色板里选，见 `COLOR_OPTIONS`）。 */
  color: string | null;
  /** 单个 emoji（≤16 字符，服务端按字符串存）。 */
  icon: string | null;
  description: string | null;
  status: string;
  sort: number;
  /** v0.0.4 W1-D1 §5.2：1=预置「默认」分组（不可删/不可归档，与服务层 GroupDto 同口径的 0/1）。 */
  is_default: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface GroupCreateInput {
  name: string;
  color?: string;
  icon?: string;
  description?: string;
  sort?: number;
}

export interface GroupPatchInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
  status?: 'ACTIVE' | 'ARCHIVED';
  sort?: number;
}

export interface GroupDeleteResult {
  id: string;
  deleted: boolean;
  strategy: 'migrate' | 'cascade';
  /** strategy=cascade 时同步删除的任务数；migrate 时为迁移过去的数量（成功 Toast 用）。 */
  affected_tasks: number;
}
