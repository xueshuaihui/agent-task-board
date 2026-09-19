import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Archive, ArchiveRestore, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { navigate } from '@/app/router';
import { useGroupingStore } from '@/features/board/grouping/useGroupingState';
import { transitions } from '@/lib/motion';
import { formatDateTime } from '@/lib/time';
import { Badge, Button, EmptyState, IconButton, Menu, Skeleton } from '@/components/ui';
import { ProjectDeleteDialog } from './project-delete-dialog';
import { ProjectFormDialog } from './project-form-dialog';
import { useProjectMutations, useProjects } from './queries';
import type { Project } from './types';

/**
 * 项目列表页 `#/projects`（15.3 / 原型 5.1）：卡片网格——名称（色点 + 图标）、描述、
 * 创建时间、状态；操作是「打开」（把该项目的过滤写进看板分组偏好后跳看板）与 `⋯`
 * 菜单（编辑 / 归档或恢复 / 删除）。
 *
 * 「任务数」列暂缺：`GET /projects` 不返回计数（ProjectDto 无 task_count），
 * 为每个项目再发一次 `/tasks` 只为凑一个数字不值得——等接口带上后补这一列。
 */
export function ProjectsPage() {
  const projects = useProjects();
  const reduced = useReducedMotion();

  const [formTarget, setFormTarget] = useState<'create' | Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  const items = projects.data?.items ?? [];
  const active = useMemo(() => items.filter((project) => project.status === 'ACTIVE'), [items]);
  const archived = useMemo(() => items.filter((project) => project.status !== 'ACTIVE'), [items]);

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.rise}
      className="flex min-h-0 w-full flex-col gap-4"
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-page-title text-text-primary">分组</h1>
          <p className="text-aux text-text-secondary">
            共 {items.length} 个 · 活跃 {active.length} · 归档 {archived.length}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<FolderPlus className="size-4" aria-hidden />}
          onClick={() => setFormTarget('create')}
          data-testid="create-project"
        >
          新建分组
        </Button>
      </header>

      {projects.isPending ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
        </div>
      ) : projects.isError ? (
        <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-bg-surface p-4">
          <p className="text-body text-status-failed">{errorMessage(projects.error)}</p>
          <Button size="sm" onClick={() => void projects.refetch()}>
            重试
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex min-h-[320px] flex-1 items-center justify-center rounded-card border border-border bg-bg-surface">
          <EmptyState
            icon={<span aria-hidden className="text-2xl leading-none">📁</span>}
            title="还没有分组"
            description="分组是任务的顶层容器，用来隔离不同的工作（5.1）"
            action={
              <Button
                variant="primary"
                icon={<FolderPlus className="size-4" aria-hidden />}
                onClick={() => setFormTarget('create')}
              >
                新建分组
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[...active, ...archived].map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onEdit={() => setFormTarget(project)}
              onDelete={() => setDeleteTarget(project)}
            />
          ))}
        </div>
      )}

      {formTarget ? (
        <ProjectFormDialog
          project={formTarget === 'create' ? null : formTarget}
          onClose={() => setFormTarget(null)}
        />
      ) : null}
      <ProjectDeleteDialog project={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </motion.div>
  );
}

function ProjectCard({
  project,
  onEdit,
  onDelete,
}: {
  project: Project;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const archived = project.status !== 'ACTIVE';
  const update = useGroupingStore((state) => state.update);

  // 5.1「打开」：把看板切成只看这个项目并按项目分组，落到看板就是它自己的泳道视图。
  const open = () => {
    update({ projectIds: [project.id], primary: 'project' });
    navigate('board');
  };

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-bg-surface p-4 shadow-card">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={project.color ? { backgroundColor: project.color } : undefined}
          />
          <span className="truncate text-card-title text-text-primary">
            {project.icon ? `${project.icon} ` : ''}
            {project.name}
          </span>
          {archived ? <Badge tone="neutral">已归档</Badge> : null}
        </div>
        <ProjectMenu project={project} archived={archived} onEdit={onEdit} onDelete={onDelete} />
      </div>

      <p className={'min-h-[20px] truncate text-aux ' + (project.description ? 'text-text-secondary' : 'text-text-tertiary')}>
        {project.description ?? '无描述'}
      </p>

      <div className="flex items-center justify-between gap-2">
        <span className="text-aux text-text-tertiary">创建于 {formatDateTime(project.created_at)}</span>
        {archived ? null : (
          <Button size="sm" variant="ghost" className="text-primary" onClick={open}>
            打开
          </Button>
        )}
      </div>
    </div>
  );
}

function ProjectMenu({
  project,
  archived,
  onEdit,
  onDelete,
}: {
  project: Project;
  archived: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mutations = useProjectMutations();
  const busy =
    mutations.archive.isPending && mutations.archive.variables === project.id ||
    mutations.restore.isPending && mutations.restore.variables === project.id;

  return (
    <Menu
      align="end"
      width={180}
      groups={[
        {
          items: [
            {
              id: 'edit',
              label: '编辑',
              icon: <Pencil className="size-3.5" aria-hidden />,
              onSelect: onEdit,
            },
            archived
              ? {
                  id: 'restore',
                  label: '恢复',
                  icon: <ArchiveRestore className="size-3.5" aria-hidden />,
                  onSelect: () => mutations.restore.mutate(project.id),
                }
              : {
                  id: 'archive',
                  label: '归档',
                  icon: <Archive className="size-3.5" aria-hidden />,
                  hint: '移出默认视图',
                  onSelect: () => mutations.archive.mutate(project.id),
                },
            {
              id: 'delete',
              label: '删除',
              danger: true,
              icon: <Trash2 className="size-3.5" aria-hidden />,
              hint: '迁移或删除任务',
              onSelect: onDelete,
            },
          ],
        },
      ]}
      trigger={({ open, toggle }) => (
        <IconButton
          label={`${project.name} 的操作`}
          size="iconSm"
          aria-expanded={open}
          loading={busy}
          onClick={toggle}
          icon={<MoreHorizontal className="size-4" />}
        />
      )}
    />
  );
}
