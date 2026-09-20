import { http } from '@/api';
import type {
  Skill,
  SkillBoundTaskList,
  SkillCreateInput,
  SkillImportConflict,
  SkillListResult,
  SkillPatchInput,
  SkillQuery,
  SkillTestResult,
  SkillVersionCreateInput,
  SkillVersionSnapshot,
} from './types';

/**
 * 技能资源 API 封装（后端契约见本 feature README）。
 *
 * 接缝说明：技能尚未注册进 `src/api/index.ts` 的 `api` 聚合对象——那是既有文件，
 * 本 feature 只新增不修改，所以这里独立导出 `skillsApi`，业务侧
 * `import { skillsApi } from '@/features/skills/api'`。主 agent 接线时若愿意，
 * 可在 `api/resources/skills.ts` 转发这份实现并挂到聚合对象上（README 有步骤）。
 * 鉴权、/api/v1 前缀、错误归一全部复用 `http`（src/api/client.ts）。
 */
function enc(id: string): string {
  return encodeURIComponent(id);
}

export const skillsApi = {
  list: (query?: SkillQuery) => http.get<SkillListResult>('/skills', query),

  get: (id: string) => http.get<Skill>(`/skills/${enc(id)}`),

  /** 创建即 v0.1.0 草稿。 */
  create: (body: SkillCreateInput) => http.post<Skill>('/skills', body),

  patch: (id: string, body: SkillPatchInput) => http.patch<Skill>(`/skills/${enc(id)}`, body),

  remove: (id: string) => http.del<void>(`/skills/${enc(id)}`),

  /** 创建新版本并设为 current（semver 由服务端自增）。 */
  createVersion: (id: string, body: SkillVersionCreateInput) =>
    http.post<Skill>(`/skills/${enc(id)}/versions`, body),

  rollback: (id: string, version: string) =>
    http.post<Skill>(`/skills/${enc(id)}/rollback`, { version }),

  /** W3 §9.6：单版本内容快照（编辑器版本历史「与当前对比」）。 */
  versionSnapshot: (id: string, version: string) =>
    http.get<SkillVersionSnapshot>(`/skills/${enc(id)}/versions/${enc(version)}`),

  test: (id: string, input: string) => http.post<SkillTestResult>(`/skills/${enc(id)}/test`, { input }),

  /** .atskill 文件内容（Content-Disposition 里的文件名后端给，这里兜底拼一个）。 */
  export: async (id: string, name: string) => {
    const result = await http.download('GET', `/skills/${enc(id)}/export`);
    saveBlob(result.blob, result.filename ?? `${name || 'skill'}.atskill`);
  },

  /**
   * 导入 .atskill：走后端 multipart 端点（W2：导入技能 source=imported，
   * 同 ID 冲突按 on_conflict 处置——fail 时后端回 409 SKILL_ID_CONFLICT）。
   */
  import: (file: File, onConflict?: SkillImportConflict) => {
    const form = new FormData();
    form.append('file', file);
    const query = onConflict ? `?on_conflict=${onConflict}` : '';
    return http.form<Skill>(`/skills/import${query}`, form);
  },

  /** SKILL.md / .mdc 导入：后端解析 frontmatter（含 id）并按同一套冲突规则落库。 */
  importMarkdown: (input: { filename: string; content: string }, onConflict?: SkillImportConflict) =>
    http.post<Skill>(
      `/skills/import-markdown${onConflict ? `?on_conflict=${onConflict}` : ''}`,
      input,
    ),

  /**
   * 绑定任务列表。契约只给了 stats.boundTaskCount，列表端点是本 feature 的
   * 契约补充（GET /skills/:id/tasks），后端按此实现即可，不实现时详情抽屉
   * 对应 Tab 走空态。
   */
  boundTasks: (id: string) => http.get<SkillBoundTaskList>(`/skills/${enc(id)}/tasks`),
};

/** 任务绑定走既有任务更新接口（PATCH /tasks/:id {skills: [{skill_id, version?}]}）。 */
export interface TaskSkillRef {
  skill_id: string;
  version?: string;
}

export const taskSkillsApi = {
  set: (taskId: string, skills: TaskSkillRef[]) =>
    http.patch<Skill>(`/tasks/${enc(taskId)}`, { skills }),
};

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
