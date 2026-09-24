import { useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { errorMessage, qk, useApiMutation } from '@/api';
import { navigate } from '@/app/router';
import { Badge, Button } from '@/components/ui';
import {
  SkillDetailDrawer,
  taskSkillsApi,
  useSkills,
  type Skill,
} from '@/features/skills';
import { SkillPicker } from '@/features/skills/skill-picker';
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
 * - D-3：绑定候选区换成共享 SkillPicker（内联多选形态）——多维模糊匹配、
 *   空查询按分类分组、命中高亮与重名消歧全走组件标准；本页只留业务过滤
 *   （排除已绑定与 ARCHIVED），行主点击仍是「打开详情抽屉」，绑定动作在 trailing 插槽。
 */
export function SkillsTab({ detail }: { detail: TaskDetailView }) {
  const taskId = detail.id;
  const all = useSkills();
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  // 候选含 DRAFT 与 PUBLISHED（排除 ARCHIVED）：下发语义不变（后端按绑定版本下发，
  // 10.1 未限制草稿），草稿技能可先绑定、发布后生效。查询匹配交给 SkillPicker（本地零请求）。

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

  const candidates = useMemo(
    () =>
      (all.data?.items ?? []).filter(
        (skill) => skill.status !== 'ARCHIVED' && !boundIds.has(skill.id),
      ),
    [all.data?.items, boundIds],
  );

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
        <SkillPicker
          candidates={candidates}
          multiple
          selectedIds={bound.map((ref) => ref.skill_id)}
          // 行主点击保持既有交互：打开技能详情；「绑定」是行尾独立动作。
          onSelect={(skill) => setDetailId(skill.id)}
          trailing={(skill) => (
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" aria-hidden />}
              disabled={setSkills.isPending}
              onClick={() => save([...bound, { skill_id: skill.id }])}
            >
              绑定
            </Button>
          )}
          placeholder="搜索技能（名称 / 分类 / 类型 / 标签 / ID，草稿与已发布）"
          emptyText="没有可绑定的技能"
          ariaLabel="绑定技能候选"
        />
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
  // 退场动画接线（统一套路）：ref 保留末次非空 skillId、open 受控——变 undefined 时不卸载，
  // 让 Drawer 经历 true→false 过渡帧播 drawerOut；关闭期间内容仍是刚才那份（AnimatePresence 冻结末次渲染）。
  const lastSkillIdRef = useRef<string | undefined>(undefined);
  if (skillId) lastSkillIdRef.current = skillId;
  const shownSkillId = skillId ?? lastSkillIdRef.current;
  // 每次真正打开递增 key 重挂：Tab 回到「概览」，与旧的「undefined→整体卸载」等价。
  const wasOpenRef = useRef(false);
  const sessionRef = useRef(0);
  if (skillId && !wasOpenRef.current) sessionRef.current += 1;
  wasOpenRef.current = Boolean(skillId);
  if (!shownSkillId) return null;
  return (
    <SkillDetailDrawer
      key={sessionRef.current}
      skillId={shownSkillId}
      open={Boolean(skillId)}
      onClose={onClose}
      onEdit={(skill) => {
        onClose();
        navigate('skills', `?edit=${encodeURIComponent(skill.id)}`);
      }}
    />
  );
}
