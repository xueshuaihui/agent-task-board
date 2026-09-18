import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { errorMessage, qk, useApiMutation } from '@/api';
import { navigate } from '@/app/router';
import { Badge, Button, Input } from '@/components/ui';
import {
  SkillDetailDrawer,
  taskSkillsApi,
  useSkills,
  type Skill,
} from '@/features/skills';
import { SKILL_TYPE_META } from '@/features/skills/meta';
import { InlineError, LoadingBlock, Section } from '../ui-bits';
import type { TaskDetailView, TaskSkillRefView } from '../types';

/**
 * 0919 10.2 任务详情「技能」Tab：随任务下发的技能绑定。
 *
 * - 读取：`detail.skills`（后端 TaskDetailDto 的 `[{skill_id, version}]` 引用，
 *   名称/类型用 `useSkills()` 的全量列表补全——技能量级是百级，不值得逐个 get）。
 * - 写入：`taskSkillsApi.set`（既有 PATCH /tasks/:id 的 `{skills}` 字段）**全量提交**；
 *   成功后失效任务根 + board/tasks 前缀（与 ../mutations.ts 的 keysFor 同口径），
 *   技能列表缓存不受影响（绑定关系存在任务侧）。
 * - 点击行打开 SkillDetailDrawer；「编辑」跳 `#/skills?edit=<id>`（技能库页内部挂编辑器）。
 */
export function SkillsTab({ detail }: { detail: TaskDetailView }) {
  const taskId = detail.id;
  const all = useSkills();
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const [keyword, setKeyword] = useState('');
  // 候选只给已发布的（1.md 10.2：草稿不下发）；keyword 由前端过滤，少发请求。
  const published = useSkills({ status: 'PUBLISHED' });

  const bound = useMemo(() => detail.skills ?? [], [detail.skills]);
  const byId = useMemo(
    () => new Map((all.data?.items ?? []).map((skill) => [skill.id, skill])),
    [all.data?.items],
  );
  const boundIds = useMemo(() => new Set(bound.map((ref) => ref.skill_id)), [bound]);

  const setSkills = useApiMutation(
    (refs: TaskSkillRefView[]) =>
      taskSkillsApi.set(
        taskId,
        refs.map((ref) => ({ skill_id: ref.skill_id, version: ref.version ?? undefined })),
      ),
    {
      // 任务详情的 skills 在 TaskDetailDto 里，overview key（qk.taskRoot）覆盖整抽屉；
      // 绑定关系也影响看板/列表的展示口径，一起失效（20.7：board 是看板唯一数据源）。
      invalidate: () => [qk.taskRoot(taskId), qk.boardRoot, qk.tasksRoot],
    },
  );

  const save = (refs: TaskSkillRefView[]) => {
    if (setSkills.isPending) return;
    setSkills.mutate(refs);
  };

  const candidates = useMemo(() => {
    const items = published.data?.items ?? [];
    const kw = keyword.trim().toLowerCase();
    return items
      .filter((skill) => !boundIds.has(skill.id))
      .filter((skill) => (kw ? skill.name.toLowerCase().includes(kw) || skill.id.toLowerCase().includes(kw) : true))
      .slice(0, 8);
  }, [published.data?.items, boundIds, keyword]);

  if (all.isPending) return <LoadingBlock lines={4} />;
  if (all.isError) return <InlineError text={all.error.message} />;

  return (
    <div className="flex flex-col gap-5">
      <Section title="已绑定技能" meta={bound.length > 0 ? `(${bound.length})` : undefined}>
        {bound.length === 0 ? (
          <p className="text-aux text-text-tertiary">
            未绑定技能：Agent 领取任务时不会注入任何技能（10.2）。
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {bound.map((ref) => (
              <SkillRow
                key={ref.skill_id}
                refRow={ref}
                skill={byId.get(ref.skill_id)}
                onOpen={() => setDetailId(ref.skill_id)}
                onUnbind={() => save(bound.filter((row) => row.skill_id !== ref.skill_id))}
                busy={setSkills.isPending}
              />
            ))}
          </ul>
        )}
        {setSkills.isError ? <InlineError text={errorMessage(setSkills.error)} /> : null}
      </Section>

      <Section title="绑定技能">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索已发布技能（名称 / ID）"
        />
        {published.isPending ? (
          <LoadingBlock lines={2} />
        ) : candidates.length === 0 ? (
          <p className="mt-2 text-aux text-text-tertiary">
            {keyword ? '没有匹配的已发布技能' : '没有可绑定的已发布技能'}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {candidates.map((skill) => (
              <li key={skill.id} className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded-control px-1 py-1 text-left text-body text-text-primary hover:bg-bg-muted"
                  onClick={() => setDetailId(skill.id)}
                >
                  {skill.name}
                  <span className="ml-2 font-mono text-aux text-text-tertiary">{skill.current_version}</span>
                </button>
                <SkillTypeBadge skill={skill} />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="size-3.5" aria-hidden />}
                  disabled={setSkills.isPending}
                  onClick={() => save([...bound, { skill_id: skill.id }])}
                >
                  绑定
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <SkillDetailDrawerHost skillId={detailId} onClose={() => setDetailId(undefined)} />
    </div>
  );
}

function SkillRow({
  refRow,
  skill,
  onOpen,
  onUnbind,
  busy,
}: {
  refRow: TaskSkillRefView;
  skill: Skill | undefined;
  onOpen: () => void;
  onUnbind: () => void;
  busy: boolean;
}) {
  return (
    <li className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        className="min-w-0 flex-1 truncate rounded-control px-1 py-1 text-left text-body text-text-primary hover:bg-bg-muted"
        onClick={onOpen}
        title={`打开技能详情 ${refRow.skill_id}`}
      >
        {skill?.name ?? refRow.skill_id}
        <span className="ml-2 font-mono text-aux text-text-tertiary">
          {refRow.version ?? skill?.current_version ?? '—'}
        </span>
      </button>
      {skill ? <SkillTypeBadge skill={skill} /> : null}
      <Button
        size="iconSm"
        variant="ghost"
        aria-label={`解绑 ${skill?.name ?? refRow.skill_id}`}
        icon={<X className="size-3.5" />}
        disabled={busy}
        onClick={onUnbind}
      />
    </li>
  );
}

function SkillTypeBadge({ skill }: { skill: Skill }) {
  const meta = SKILL_TYPE_META[skill.type];
  return <Badge tone="outline">{meta?.label ?? skill.type}</Badge>;
}

/** 详情抽屉挂载在 Tab 内部：编辑跳技能库页的 `?edit=` 深链（路由接线见 features/skills README）。 */
function SkillDetailDrawerHost({ skillId, onClose }: { skillId: string | undefined; onClose: () => void }) {
  if (!skillId) return null;
  return (
    <SkillDetailDrawer
      skillId={skillId}
      open
      onClose={onClose}
      onEdit={(skill) => {
        onClose();
        navigate('skills', `?edit=${encodeURIComponent(skill.id)}`);
      }}
    />
  );
}
