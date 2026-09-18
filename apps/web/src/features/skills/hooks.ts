import { useQuery } from '@tanstack/react-query';
import { useApiMutation } from '@/api';
import type { QueryKey } from '@tanstack/react-query';
import { skillsApi } from './api';
import type { Skill, SkillCreateInput, SkillPatchInput, SkillQuery } from './types';

/**
 * 技能 feature 的查询 key。技能尚未接进 src/api/keys.ts（不修改既有文件），
 * 这里自带一份独立前缀 `['skills', ...]`；主 agent 若把资源挂进 `qk`，
 * 换成 `qk.skills(...)` 即可（本文件只有这几处引用）。
 * WS 自动失效自然不会覆盖它——技能页自己写操作自己失效（见下方 invalidate）。
 */

export const skillKeys = {
  root: ['skills'] as const,
  list: (query?: SkillQuery) => ['skills', 'list', query ?? {}] as const,
  detail: (id: string) => ['skills', 'detail', id] as const,
  boundTasks: (id: string) => ['skills', 'detail', id, 'bound-tasks'] as const,
};

type Options = { enabled?: boolean };

export function useSkills(query?: SkillQuery, options?: Options) {
  return useQuery({
    queryKey: skillKeys.list(query),
    queryFn: () => skillsApi.list(query),
    enabled: options?.enabled,
  });
}

export function useSkill(id: string | undefined, options?: Options) {
  return useQuery({
    queryKey: skillKeys.detail(id ?? ''),
    queryFn: () => skillsApi.get(id as string),
    enabled: Boolean(id) && (options?.enabled ?? true),
  });
}

export function useSkillBoundTasks(id: string | undefined, options?: Options) {
  return useQuery({
    queryKey: skillKeys.boundTasks(id ?? ''),
    queryFn: () => skillsApi.boundTasks(id as string),
    enabled: Boolean(id) && (options?.enabled ?? true),
  });
}

function rootInvalidate(): readonly QueryKey[] {
  return [skillKeys.root];
}

export function useCreateSkill(onSuccess?: (skill: Skill) => void) {
  return useApiMutation((body: SkillCreateInput) => skillsApi.create(body), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

export function usePatchSkill(onSuccess?: (skill: Skill) => void) {
  return useApiMutation(
    (vars: { id: string; body: SkillPatchInput }) => skillsApi.patch(vars.id, vars.body),
    {
      invalidate: rootInvalidate(),
      onSuccess,
    },
  );
}

export function useDeleteSkill(onSuccess?: () => void) {
  return useApiMutation((id: string) => skillsApi.remove(id), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}

/** 发布 = 新建版本（服务端设 current，随版本声明 mcp_dependencies）+ 置为 PUBLISHED。 */
export function usePublishSkill(onSuccess?: (skill: Skill) => void) {
  return useApiMutation(
    (vars: {
      id: string;
      content: Skill['content'];
      changelog: string;
      mcp: Skill['mcp_dependencies'];
    }) =>
      skillsApi
        .createVersion(vars.id, {
          content: vars.content,
          changelog: vars.changelog,
          mcp_dependencies: vars.mcp,
        })
        .then(() => skillsApi.patch(vars.id, { status: 'PUBLISHED' })),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useRollbackSkill(onSuccess?: (skill: Skill) => void) {
  return useApiMutation(
    (vars: { id: string; version: string }) => skillsApi.rollback(vars.id, vars.version),
    { invalidate: rootInvalidate(), onSuccess },
  );
}

export function useTestSkill() {
  return useApiMutation((vars: { id: string; input: string }) => skillsApi.test(vars.id, vars.input), {
    toastOnError: false,
  });
}

export function useImportSkill(onSuccess?: (skill: Skill) => void) {
  return useApiMutation((file: File) => skillsApi.import(file), {
    invalidate: rootInvalidate(),
    onSuccess,
  });
}
