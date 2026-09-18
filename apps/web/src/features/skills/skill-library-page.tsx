import { useMemo, useState } from 'react';
import { Plus, Search, Upload } from 'lucide-react';
import {
  Button,
  CardSkeleton,
  EmptyState,
  Input,
  Select,
  useToast,
} from '@/components/ui';
import { errorMessage } from '@/api';
import { skillsApi } from './api';
import { CreateSkillDialog } from './create-skill-dialog';
import { ImportSkillDialog } from './import-skill-dialog';
import { useDeleteSkill, useSkills } from './hooks';
import { SKILL_STATUS_META, SKILL_TYPE_OPTIONS } from './meta';
import { SkillCard } from './skill-card';
import { SkillDetailDrawer } from './skill-detail-drawer';
import { SkillEditorPage } from './skill-editor-page';
import type { Skill, SkillQuery, SkillStatus, SkillType } from './types';

/**
 * 技能库页（2.md 10.1/10.2）。路由：`#/skills`；编辑器以查询参数挂载
 * `#/skills?edit=<skillId>`（hash 自研路由只认命名路由，见 README「路由接线」）。
 *
 * 接缝（供主 agent 接线）：
 * - 注册路由：app/router.tsx 的 ROUTES 增加 `skills`，app/app.tsx 的 PAGES 挂本页；
 * - 任务详情「技能标签」Tab：绑定走 `taskSkillsApi.set`（本 feature api.ts）；
 * - 看板卡片技能角标：用 `useSkills` 轻查询 + `SkillDetailDrawer`。
 */

const LIBRARY_PATH = '/skills';

function libraryHref(search: string): string {
  return `#${LIBRARY_PATH}${search}`;
}

export function SkillLibraryPage() {
  const toast = useToast();
  const [keywordInput, setKeywordInput] = useState('');
  const [type, setType] = useState<SkillType | ''>('');
  const [status, setStatus] = useState<SkillStatus | ''>('');

  /* `?edit=` 挂编辑器；其余查询参数留给后续（如 tag 深链）。 */
  const search = typeof window !== 'undefined' ? window.location.hash.split('?')[1] ?? '' : '';
  const editingId = new URLSearchParams(search).get('edit');

  const query: SkillQuery = useMemo(
    () => ({ keyword: keywordInput || undefined, type: type || undefined, status: status || undefined }),
    [keywordInput, type, status],
  );
  const skills = useSkills(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const remove = useDeleteSkill();

  const openEditor = (skill: Skill) => {
    window.location.hash = libraryHref(`?edit=${encodeURIComponent(skill.id)}`);
  };
  const closeEditor = () => {
    window.location.hash = libraryHref('');
  };

  if (editingId) {
    return (
      <SkillEditorPage
        skillId={editingId}
        onClose={closeEditor}
        onOpenDetail={(skill) => setDetailId(skill.id)}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-page-title text-text-primary">技能库</h1>
          <p className="text-aux text-text-secondary">
            {skills.data ? `${skills.data.total} 个技能` : '本地技能与流程编排'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="default" icon={<Upload className="size-4" />} onClick={() => setImportOpen(true)}>
            导入
          </Button>
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
            新建技能
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            value={keywordInput}
            placeholder="搜索名称、描述、标签…"
            className="w-64 pl-8"
            onChange={(event) => setKeywordInput(event.target.value)}
          />
        </div>
        <Select
          className="w-32"
          value={type}
          placeholder="全部类型"
          options={[{ value: '', label: '全部类型' }, ...SKILL_TYPE_OPTIONS]}
          onChange={(event) => setType(event.target.value as SkillType | '')}
        />
        <Select
          className="w-32"
          value={status}
          placeholder="全部状态"
          options={[
            { value: '', label: '全部状态' },
            ...(Object.keys(SKILL_STATUS_META) as SkillStatus[]).map((value) => ({
              value,
              label: SKILL_STATUS_META[value].label,
            })),
          ]}
          onChange={(event) => setStatus(event.target.value as SkillStatus | '')}
        />
      </div>

      {skills.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : skills.isError ? (
        <EmptyState
          title="技能库加载失败"
          description={errorMessage(skills.error)}
          action={
            <Button size="sm" onClick={() => skills.refetch()}>
              重试
            </Button>
          }
        />
      ) : (skills.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={keywordInput || type || status ? '没有匹配的技能' : '还没有技能'}
          description={
            keywordInput || type || status ? '试试放宽筛选条件' : '新建第一个技能，或从 .atskill 文件导入'
          }
          action={
            keywordInput || type || status ? (
              <Button
                size="sm"
                onClick={() => {
                  setKeywordInput('');
                  setType('');
                  setStatus('');
                }}
              >
                清除筛选
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
                新建技能
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
          {skills.data.items.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onOpen={(target) => setDetailId(target.id)}
              onEdit={openEditor}
              onPublish={openEditor}
              onExport={(target) => {
                skillsApi
                  .export(target.id, target.name)
                  .catch((error) => toast.error('导出失败', errorMessage(error)));
              }}
              onDelete={(target) => {
                if (window.confirm(`删除技能「${target.name}」？此操作不可撤销`)) {
                  remove.mutate(target.id, {
                    onError: (error) => toast.error('删除失败', errorMessage(error)),
                  });
                }
              }}
            />
          ))}
        </div>
      )}

      <CreateSkillDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={openEditor} />
      <ImportSkillDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={(skill) => setDetailId(skill.id)} />
      <SkillDetailDrawer
        skillId={detailId}
        open={Boolean(detailId)}
        onClose={() => setDetailId(undefined)}
        onEdit={(skill) => {
          setDetailId(undefined);
          openEditor(skill);
        }}
      />
    </div>
  );
}

/** 顶栏导航候选：主 agent 接线时并入 ROUTES 即可（README）。 */
export const skillsRouteCandidate = { path: LIBRARY_PATH, label: '技能' } as const;
