import { Copy, Download, FileText, FolderOpen, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui';
import { Card } from '@/components/ui';
import { Menu } from '@/components/ui';
import { TagBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/time';
import { categoryDisplay } from './skill-picker-core';
import type { Skill } from './types';
import { SKILL_ORIGIN_META, SKILL_STATUS_META, SKILL_TYPE_META } from './meta';

/**
 * 技能卡片（2.md 10.2）：类型徽标 + 名称 + 描述 + 标签 + 分隔线下的
 * 状态/版本/绑定任务数，右上角操作菜单。
 * v0.0.4 W2：来源徽标（§9.10 三来源）；默认技能只读——编辑/发布/删除置灰；
 * duplicateName 时名称追加 id 短后缀消歧（§9.2 r2 允许重名）。
 * C-6b①：卡片显式展示分类徽标——口径与筛选器同源（直读 skill.category、
 * 未分类走 UNCATEGORIZED_LABEL，复用 skill-picker-core 的 categoryDisplay），
 * 绝不从 tags 推导；徽标（Badge tone + 分类图标）与自由标签 TagBadge 视觉分家，
 * 消灭「卡片上看到的还是两套分类标准」的观感。tags 仍只渲染前 3 个（现状不变）。
 */

export interface SkillCardProps {
  skill: Skill;
  /** 同名消歧后缀（库页计算：仅当列表里出现同名技能时传入）。 */
  duplicateName?: boolean;
  onOpen: (skill: Skill) => void;
  onEdit: (skill: Skill) => void;
  onPublish: (skill: Skill) => void;
  onExport: (skill: Skill) => void;
  onExportMarkdown: (skill: Skill) => void;
  onCopy: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
  className?: string;
}

export function SkillCard({
  skill,
  duplicateName,
  onOpen,
  onEdit,
  onPublish,
  onExport,
  onExportMarkdown,
  onCopy,
  onDelete,
  className,
}: SkillCardProps) {
  const status = SKILL_STATUS_META[skill.status];
  const origin = SKILL_ORIGIN_META[skill.source];
  const OriginIcon = origin.icon;
  // r2：同名技能靠 id 短后缀消歧（id 终身唯一，界面靠 ID+名称+来源区分）。
  const displayName = duplicateName ? `${skill.name} ·${skill.id.slice(-6)}` : skill.name;

  return (
    <Card
      hoverable
      className={cn('flex cursor-pointer flex-col gap-2 p-4', className)}
      onClick={() => onOpen(skill)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-tag text-code',
              SKILL_TYPE_META[skill.type] ? 'bg-primary-light text-primary' : 'bg-bg-muted',
            )}
          >
            {skill.name.slice(0, 1).toUpperCase()}
          </span>
          <p className="truncate text-card-title text-text-primary" title={skill.name}>
            {displayName}
          </p>
        </div>
        <div
          className="shrink-0"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Menu
            align="end"
            width={180}
            trigger={({ toggle }) => (
              <button
                type="button"
                aria-label="技能操作"
                onClick={toggle}
                className="flex size-7 items-center justify-center rounded-control text-text-tertiary hover:bg-bg-raised hover:text-text-primary"
              >
                <MoreHorizontal className="size-4" />
              </button>
            )}
            groups={[
              {
                items: [
                  /* W3：默认技能也进编辑器——整页只读态呈现（守卫在页面与服务端）。 */
                  { id: 'edit', label: skill.readonly ? '查看（只读）' : '编辑', icon: <Pencil className="size-4" />, onSelect: () => onEdit(skill) },
                  {
                    id: 'publish',
                    label: '发布新版本',
                    icon: <Send className="size-4" />,
                    disabled: skill.readonly || skill.status === 'ARCHIVED',
                    onSelect: () => onPublish(skill),
                  },
                  {
                    id: 'copy',
                    label: '复制',
                    icon: <Copy className="size-4" />,
                    onSelect: () => onCopy(skill),
                  },
                  {
                    id: 'export',
                    label: '导出 .atskill',
                    icon: <Download className="size-4" />,
                    onSelect: () => onExport(skill),
                  },
                  {
                    id: 'export-md',
                    label: '导出 SKILL.md',
                    icon: <FileText className="size-4" />,
                    onSelect: () => onExportMarkdown(skill),
                  },
                  {
                    id: 'delete',
                    label: '删除',
                    icon: <Trash2 className="size-4" />,
                    danger: true,
                    disabled: skill.readonly,
                    onSelect: () => onDelete(skill),
                  },
                ],
              },
            ]}
          />
        </div>
      </div>

      <p className="line-clamp-2 min-h-[2lh] text-aux text-text-secondary">
        {skill.description || '（暂无描述）'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{SKILL_TYPE_META[skill.type]?.label ?? skill.type}</Badge>
        <span
          className={cn('inline-flex items-center gap-1 rounded-badge px-2 py-0.5 text-badge', origin.className)}
          title={`来源：${origin.label}`}
        >
          <OriginIcon className="size-3" />
          {origin.label}
        </span>
        <span className={cn('rounded-badge px-2 py-0.5 text-badge', status.className)}>
          {status.label}
        </span>
        {/* 分类徽标：带 lucide 分类图标 + Badge 语义 tone（做法对齐上方来源徽标——
            图标承载语义、中性底区别于 TagBadge 的 primary 标签 chip）。 */}
        <Badge tone="neutral" icon={<FolderOpen className="size-3" aria-hidden />}>
          {categoryDisplay(skill)}
        </Badge>
        {skill.tags.slice(0, 3).map((tag) => (
          <TagBadge key={tag}>{tag}</TagBadge>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-aux text-text-tertiary">
        <span className="tabular-nums">
          {skill.current_version} · 更新于 {formatRelative(skill.updated_at)}
        </span>
        <span className="tabular-nums">{skill.stats?.bound_task_count ?? 0} 个任务绑定</span>
      </div>
    </Card>
  );
}
