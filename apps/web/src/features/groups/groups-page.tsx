import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Archive, ArchiveRestore, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { navigate } from '@/app/router';
import { useGroupingStore } from '@/features/board/grouping/useGroupingState';
import { transitions } from '@/lib/motion';
import { formatDateTime } from '@/lib/time';
import { Badge, Button, EmptyState, IconButton, Menu, Skeleton } from '@/components/ui';
import { GroupDeleteDialog } from './group-delete-dialog';
import { GroupFormDialog } from './group-form-dialog';
import { useGroupMutations, useGroups } from './queries';
import { GROUP_LIMIT, type Group } from './types';

/**
 * 分组列表页 `#/groups`（15.3 / 原型 5.1）：卡片网格——名称（色点 + 图标）、描述、
 * 创建时间、状态；操作是「打开」（把该分组的过滤写进看板分组偏好后跳看板）与 `⋯`
 * 菜单（编辑 / 归档或恢复 / 删除）。
 *
 * v0.0.4 W4 §5.6：卡片带上任务数与归档时刻（`GET /groups` 列表顺路返回
 * `task_count` / `unfinished_count`）；组内还有未完成任务时「归档」置灰并提示
 * 剩余数（服务端 GROUP_NOT_ALL_DONE 409 兜底）。
 */
export function GroupsPage() {
  const groups = useGroups();
  const reduced = useReducedMotion();

  const [formTarget, setFormTarget] = useState<'create' | Group | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);

  const items = groups.data?.items ?? [];
  const active = useMemo(() => items.filter((group) => group.status === 'ACTIVE'), [items]);
  const archived = useMemo(() => items.filter((group) => group.status !== 'ACTIVE'), [items]);
  /** §5.5：活跃分组占满配额后不再让新建（服务端同样会拒 409）。 */
  const atLimit = active.length >= GROUP_LIMIT;

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
            共 {items.length} 个 · 活跃 {active.length}/{GROUP_LIMIT} · 归档 {archived.length}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<FolderPlus className="size-4" aria-hidden />}
          onClick={() => setFormTarget('create')}
          disabled={atLimit}
          title={atLimit ? `分组数量已达上限 ${GROUP_LIMIT} 个，先删除不用的分组` : undefined}
          data-testid="create-group"
        >
          新建分组
        </Button>
      </header>

      {atLimit ? (
        <p className="text-aux text-text-secondary">
          活跃分组已达上限 {GROUP_LIMIT} 个，删除不用的分组后才能新建。
        </p>
      ) : null}

      {groups.isPending ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
        </div>
      ) : groups.isError ? (
        <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-bg-surface p-4">
          <p className="text-body text-status-failed">{errorMessage(groups.error)}</p>
          <Button size="sm" onClick={() => void groups.refetch()}>
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
          {[...active, ...archived].map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              onEdit={() => setFormTarget(group)}
              onDelete={() => setDeleteTarget(group)}
            />
          ))}
        </div>
      )}

      {formTarget ? (
        <GroupFormDialog
          group={formTarget === 'create' ? null : formTarget}
          onClose={() => setFormTarget(null)}
        />
      ) : null}
      <GroupDeleteDialog group={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </motion.div>
  );
}

function GroupCard({
  group,
  onEdit,
  onDelete,
}: {
  group: Group;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const archived = group.status !== 'ACTIVE';
  /** v0.0.4 W1-D1 §5.2/§5.4：预置「默认」分组带标识、无删除（与归档）入口。 */
  const isDefault = group.is_default === 1;
  const update = useGroupingStore((state) => state.update);

  // 5.1「打开」：把看板切成只看这个分组并按分组泳道，落到看板就是它自己的泳道视图。
  const open = () => {
    update({ groupIds: [group.id], primary: 'group' });
    navigate('board');
  };

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-bg-surface p-4 shadow-card">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={group.color ? { backgroundColor: group.color } : undefined}
          />
          <span className="truncate text-card-title text-text-primary">
            {group.icon ? `${group.icon} ` : ''}
            {group.name}
          </span>
          {isDefault ? <Badge tone="soft">默认</Badge> : null}
          {archived ? <Badge tone="neutral">已归档</Badge> : null}
        </div>
        <GroupMenu
          group={group}
          archived={archived}
          protectedDefault={isDefault}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>

      <p className={'min-h-[20px] truncate text-aux ' + (group.description ? 'text-text-secondary' : 'text-text-tertiary')}>
        {group.description ?? '无描述'}
      </p>

      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-aux text-text-tertiary">
          {group.task_count !== undefined ? `${group.task_count} 任务 · ` : ''}
          {archived ? `归档于 ${formatDateTime(group.archived_at)} · ` : ''}创建于 {formatDateTime(group.created_at)}
        </span>
        {archived ? null : (
          <Button size="sm" variant="ghost" className="text-primary" onClick={open}>
            打开
          </Button>
        )}
      </div>
    </div>
  );
}

function GroupMenu({
  group,
  archived,
  protectedDefault,
  onEdit,
  onDelete,
}: {
  group: Group;
  archived: boolean;
  /** §5.2/§5.6：默认分组不渲染删除与归档入口（服务端另有 409 兜底）。 */
  protectedDefault: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mutations = useGroupMutations();
  const busy =
    mutations.archive.isPending && mutations.archive.variables === group.id ||
    mutations.restore.isPending && mutations.restore.variables === group.id;
  /** §5.6：组内还有未完成/未归档任务时归档入口置灰并提示剩余数（服务端 409 兜底）。 */
  const remaining = group.unfinished_count ?? 0;

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
            ...(protectedDefault
              ? []
              : [
                  archived
                    ? {
                        id: 'restore',
                        label: '恢复',
                        icon: <ArchiveRestore className="size-3.5" aria-hidden />,
                        onSelect: () => mutations.restore.mutate(group.id),
                      }
                    : {
                        id: 'archive',
                        label: '归档',
                        icon: <Archive className="size-3.5" aria-hidden />,
                        hint: remaining > 0 ? `还剩 ${remaining} 个任务` : '需全部完成',
                        disabled: remaining > 0,
                        onSelect: () => mutations.archive.mutate(group.id),
                      },
                  {
                    id: 'delete',
                    label: '删除',
                    danger: true,
                    icon: <Trash2 className="size-3.5" aria-hidden />,
                    hint: '迁移或删除任务',
                    onSelect: onDelete,
                  },
                ]),
          ],
        },
      ]}
      trigger={({ open, toggle }) => (
        <IconButton
          label={`${group.name} 的操作`}
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
