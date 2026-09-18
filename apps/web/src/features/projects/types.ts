/**
 * 0919 五章：项目（任务的顶层容器）。字段与后端 `apps/api/src/projects/projects.service.ts`
 * 的 `ProjectDto` 同名同口径——此处是前端唯一出处，feature 内不要重复声明。
 */

export interface Project {
  id: string;
  name: string;
  /** 16 进制色值（新建/编辑时从状态色 token 调色板里选，见 `COLOR_OPTIONS`）。 */
  color: string | null;
  /** 单个 emoji（≤16 字符，服务端按字符串存）。 */
  icon: string | null;
  description: string | null;
  status: string;
  sort: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProjectCreateInput {
  name: string;
  color?: string;
  icon?: string;
  description?: string;
  sort?: number;
}

export interface ProjectPatchInput {
  name?: string;
  color?: string | null;
  icon?: string | null;
  description?: string | null;
  status?: 'ACTIVE' | 'ARCHIVED';
  sort?: number;
}

export interface ProjectDeleteResult {
  id: string;
  deleted: boolean;
  strategy: 'migrate' | 'delete';
  /** strategy=delete 时同步删除的任务数；migrate 时为迁移过去的数量（成功 Toast 用）。 */
  affected_tasks: number;
}
