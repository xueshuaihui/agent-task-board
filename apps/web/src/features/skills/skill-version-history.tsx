import { useState } from 'react';
import { ArrowLeft, GitCompareArrows, History, RotateCcw } from 'lucide-react';
import { Button, Dialog, EmptyState, Skeleton, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { formatDateTime } from '@/lib/time';
import { BLOCK_KIND_META, blockTitle } from './meta';
import { useRollbackSkill, useSkillVersionSnapshot } from './hooks';
import { diffFieldLabel, diffSkillContent, entryLabel, reorderLabel } from './version-diff';
import type { Skill, SkillContent, SkillVersionSnapshot } from './types';

/**
 * v0.0.4 W3 §9.6 编辑器版本工作流：头部「版本 n」按钮 → 版本历史对话框，
 * 列表（版本/变更说明/时间/当前标记）支持「与当前对比」（块级 diff，
 * version-diff.ts 纯函数）与「回滚到此版」（复用 POST /rollback，成功后
 * 编辑器草稿整体替换为回滚结果）。默认技能无版本（§9.6），按钮不渲染。
 */

export interface SkillVersionHistoryProps {
  skill: Skill;
  /** 编辑器当前草稿（diff 的「新版」一侧）。 */
  draft: SkillContent;
  /** 回滚成功后拿到最新 Skill（含 content），页面用它重置草稿。 */
  onRolledBack: (updated: Skill) => void;
}

export function SkillVersionHistory({ skill, draft, onRolledBack }: SkillVersionHistoryProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const versions = skill.versions ?? [];

  const rollback = useRollbackSkill((updated) => {
    toast.success('已回滚', `当前版本 ${updated.current_version}，草稿已同步为回滚内容`);
    setSelected(null);
    setOpen(false);
    onRolledBack(updated);
  });

  if (skill.readonly || versions.length === 0) return null;

  return (
    <>
      <Button
        variant="default"
        size="sm"
        icon={<History className="size-4" />}
        onClick={() => setOpen(true)}
      >
        版本 {versions.length}
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          setSelected(null);
        }}
        title={selected ? `对比 ${selected} → 当前草稿` : '版本历史'}
      >
        {selected ? (
          <VersionDiff skill={skill} version={selected} draft={draft} onBack={() => setSelected(null)} />
        ) : (
          <ul className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto atb-scroll">
            {versions.map((version) => (
              <li
                key={version.version}
                className="flex items-center gap-2 rounded-control border border-border bg-bg-surface px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-body tabular-nums text-text-primary">{version.version}</span>
                    {version.current ? (
                      <span className="rounded-badge bg-primary-light px-1.5 py-px text-badge text-primary">当前</span>
                    ) : null}
                    <span className="truncate text-aux text-text-tertiary">{formatDateTime(version.created_at)}</span>
                  </span>
                  <span className="block truncate text-aux text-text-secondary">
                    {version.changelog || '（无变更说明）'}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<GitCompareArrows className="size-4" />}
                  onClick={() => setSelected(version.version)}
                >
                  对比
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-status-failed hover:text-status-failed"
                  icon={<RotateCcw className="size-4" />}
                  disabled={version.current || rollback.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `回滚到 ${version.version}？服务端把该版本内容置为 current；编辑器草稿有未保存修改会被覆盖。`,
                      )
                    ) {
                      rollback.mutate(
                        { id: skill.id, version: version.version },
                        { onError: (error) => toast.error('回滚失败', errorMessage(error)) },
                      );
                    }
                  }}
                >
                  回滚
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}

/** 单侧 diff 视图：拉版本快照（useSkillVersionSnapshot），与草稿做块级对比。 */
function VersionDiff({
  skill,
  version,
  draft,
  onBack,
}: {
  skill: Skill;
  version: string;
  draft: SkillContent;
  onBack: () => void;
}) {
  const snapshot = useSkillVersionSnapshot(skill.id, version);
  if (snapshot.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (snapshot.isError || !snapshot.data) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body text-status-failed">{errorMessage(snapshot.error)}</p>
        <Button variant="default" size="sm" onClick={onBack}>
          返回版本列表
        </Button>
      </div>
    );
  }
  return <DiffBody from={snapshot.data} to={draft} onBack={onBack} />;
}

function DiffBody({ from, to, onBack }: { from: SkillVersionSnapshot; to: SkillContent; onBack: () => void }) {
  const diff = diffSkillContent(from.content, to);
  return (
    <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto atb-scroll">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" icon={<ArrowLeft className="size-4" />} onClick={onBack}>
          版本列表
        </Button>
        <span className="text-aux tabular-nums text-text-tertiary">
          {from.version} → 当前草稿（{to.blocks.length} 块 vs {from.content.blocks.length} 块）
        </span>
      </div>
      {diff.isEmpty ? (
        <EmptyState title="无内容差异" description="该版本与当前草稿的块内容一致（名称/描述等元信息不在快照 diff 范围）" />
      ) : (
        <div className="flex flex-col gap-2 text-body">
          {diff.entryChanged ? (
            <DiffRow tone="neutral">
              入口块：{entryLabel(from.content, to, diff.fromEntryId)} → {entryLabel(from.content, to, diff.toEntryId)}
            </DiffRow>
          ) : null}
          {diff.added.map(({ block, index }) => (
            <DiffRow key={`a-${block.id}`} tone="add">
              新增 {kindLabel(block)}「{blockTitle(block, index)}」
            </DiffRow>
          ))}
          {diff.removed.map(({ block, index }) => (
            <DiffRow key={`r-${block.id}`} tone="remove">
              删除 {kindLabel(block)}「{blockTitle(block, index)}」
            </DiffRow>
          ))}
          {diff.changed.map(({ before, after, fields, index }) => (
            <DiffRow key={`c-${after.id}`} tone="change">
              修改 {kindLabel(after)}「{blockTitle(after, index)}」：{fields.map(diffFieldLabel).join('、')}
              <span className="mt-0.5 block truncate text-aux text-text-tertiary">
                {summarize(before)} ⇒ {summarize(after)}
              </span>
            </DiffRow>
          ))}
          {diff.reorderedIds.length > 0 ? (
            <DiffRow tone="neutral">
              顺序调整：{diff.reorderedIds.map((id) => reorderLabel(from.content, to, id)).join('；')}
            </DiffRow>
          ) : null}
        </div>
      )}
    </div>
  );
}

function kindLabel(block: SkillContent['blocks'][number]): string {
  return BLOCK_KIND_META[block.kind].label;
}

function summarize(block: SkillContent['blocks'][number]): string {
  const text = BLOCK_KIND_META[block.kind].summary(block);
  return text || blockTitle(block, 0);
}

function DiffRow({ tone, children }: { tone: 'add' | 'remove' | 'change' | 'neutral'; children: React.ReactNode }) {
  const className =
    tone === 'add'
      ? 'border-status-done/40 bg-status-done-soft'
      : tone === 'remove'
        ? 'border-status-failed/40 bg-status-failed-soft'
        : tone === 'change'
          ? 'border-status-review/40 bg-status-review-soft'
          : 'border-border bg-bg-raised';
  return (
    <p className={`rounded-control border px-3 py-1.5 text-aux text-text-primary ${className}`}>{children}</p>
  );
}
