import { Copy, Download, FileText, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui';
import { Card } from '@/components/ui';
import { Menu } from '@/components/ui';
import { TagBadge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/time';
import type { Skill } from './types';
import { SKILL_STATUS_META, SKILL_TYPE_META } from './meta';

/**
 * 技能卡片（2.md 10.2）：类型徽标 + 名称 + 描述 + 标签 + 分隔线下的
 * 状态/版本/绑定任务数，右上角操作菜单。来源只有「本地」一种（云端市场不在本次范围）。
 */

export interface SkillCardProps {
  skill: Skill;
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
          <p className="truncate text-card-title text-text-primary">{skill.name}</p>
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
                  { id: 'edit', label: '编辑', icon: <Pencil className="size-4" />, onSelect: () => onEdit(skill) },
                  {
                    id: 'publish',
                    label: '发布新版本',
                    icon: <Send className="size-4" />,
                    disabled: skill.status === 'ARCHIVED',
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
        <span className={cn('rounded-badge px-2 py-0.5 text-badge', status.className)}>
          {status.label}
        </span>
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
