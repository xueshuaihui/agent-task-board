import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { GroupGlyph } from '@/features/groups/group-glyph';
import { useGroupMutations, useGroups } from '@/features/groups/queries';
import { formatDateTime } from '@/lib/time';
import { Button } from '@/components/ui';
import { useGroupingStore } from './useGroupingState';

/**
 * v0.0.4 W4 §5.6 / §6.2.2：分组泳道视图末尾的「已归档分组」折叠区。
 *
 * 归档分组的泳道默认不在看板数据里（服务端 `buildFilters` 排除，验收 72）；
 * 这里不读任务数据，只读分组缓存（`useGroups` 已带 `archived=true`）。
 * 每行给 §5.6「查看与恢复」的两个入口：
 * - 查看：把看板限定到该分组（`groupIds:[id]` + 分组泳道）。显式选中归档组时
 *   服务端会返回其任务（只读快照），泳道即该组的完整视图；
 * - 恢复：`POST /groups/:id/unarchive`——重新占 50 上限，满了服务端 409
 *   （GROUP_LIMIT_REACHED）走默认 Toast；成功后偏好里若还scope着该组，切回全部分组。
 */
export function ArchivedGroupsSection() {
  const [expanded, setExpanded] = useState(false);
  const groups = useGroups();
  const mutations = useGroupMutations();
  const update = useGroupingStore((state) => state.update);
  const groupIds = useGroupingStore((state) => state.groupIds);

  const archived = useMemo(
    () => (groups.data?.items ?? []).filter((group) => group.status === 'ARCHIVED'),
    [groups.data?.items],
  );
  if (archived.length === 0) return null;

  return (
    <section className="rounded-[10px] border border-border bg-bg-surface" data-testid="archived-groups">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-bg-raised"
      >
        <span className="flex items-center gap-2 text-section-title text-text-secondary">
          <span aria-hidden>📥</span>
          已归档分组（{archived.length}）
        </span>
        <span className="flex items-center gap-2 text-aux text-text-tertiary">
          归档分组默认隐藏、转为只读
          {expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        </span>
      </button>

      {expanded ? (
        <ul className="border-t border-border">
          {archived.map((group) => (
            <li key={group.id} className="flex items-center gap-3 border-b border-border px-5 py-2.5 last:border-b-0">
              <GroupGlyph group={group} />
              <span className="min-w-0 truncate text-body text-text-primary">{group.name}</span>
              <span className="shrink-0 text-aux text-text-tertiary">
                {group.task_count ?? 0} 任务 · 归档于 {formatDateTime(group.archived_at)}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-primary"
                  onClick={() => update({ groupIds: [group.id], primary: 'group' })}
                >
                  查看
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={mutations.restore.isPending && mutations.restore.variables === group.id}
                  onClick={() => {
                    // 恢复后如果看板还scope在「只有这一组」（正是归档区里的「查看」留下的），
                    // 清回全部分组，让恢复的泳道回到默认视图里可见。
                    if (groupIds.length === 1 && groupIds[0] === group.id) update({ groupIds: [] });
                    mutations.restore.mutate(group.id);
                  }}
                >
                  恢复
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
