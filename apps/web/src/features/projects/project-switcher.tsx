import { Check, FolderPlus, Settings2 } from 'lucide-react';
import { navigate } from '@/app/router';
import { Menu, MenuCaret, type MenuProps } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useGroupingStore } from '@/features/board/grouping/useGroupingState';
import { useActiveProjects } from './queries';
import { ProjectGlyph } from './project-glyph';

/**
 * 7.8 / 4.5 项目切换器：`项目: [全部项目 ▾]`，多选。
 *
 * 状态真值是分组 store 的 `projectIds`（空数组 = 全部项目），选中 >1 时联动把主分组
 * 切成「项目」（原型 4.5「选中多个项目时，看板自动按项目分组」）——联动走 store 的
 * `update`，让偏好持久化（localStorage）在同一个入口落盘。归档项目不出现在候选里（5.1）。
 *
 * Menu 是单选语义的控件（selectedId 画一个对勾），多选在这里用「对勾图标」表达勾选态，
 * 与 7.8 的 ☑ 原型对齐；MenuCaret/触发按钮样式沿用工具栏 chip 的规格。
 */
export function ProjectSwitcher() {
  const projects = useActiveProjects();
  const projectIds = useGroupingStore((state) => state.projectIds);
  const update = useGroupingStore((state) => state.update);

  const items = projects.data?.items ?? [];
  const allSelected = projectIds.length === 0;

  const setSelection = (next: string[]) => {
    // 4.5：选中 >1 项目自动按项目为主分组；回到 ≤1 时不改用户的原选择。
    update({ projectIds: next, ...(next.length > 1 ? { primary: 'project' } : {}) });
  };

  const toggle = (id: string) => {
    setSelection(
      projectIds.includes(id) ? projectIds.filter((value) => value !== id) : [...projectIds, id],
    );
  };

  const groups: MenuProps['groups'] = [
    {
      items: [
        {
          id: 'all',
          label: '全部分组',
          icon: allSelected ? <Check className="size-3.5 text-primary" aria-hidden /> : undefined,
          onSelect: () => setSelection([]),
        },
      ],
    },
    {
      label: '选择分组',
      items:
        items.length === 0
          ? [{ id: 'no-project', label: '还没有分组', disabled: true }]
          : items.map((project) => {
              const checked = projectIds.includes(project.id);
              return {
                id: project.id,
                label: (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <ProjectGlyph project={project} />
                    <span className="truncate">{project.name}</span>
                  </span>
                ),
                icon: checked ? <Check className="size-3.5 text-primary" aria-hidden /> : undefined,
                onSelect: () => toggle(project.id),
              };
            }),
    },
    {
      items: [
        {
          id: 'create',
          label: '新建分组',
          icon: <FolderPlus className="size-3.5" aria-hidden />,
          onSelect: () => navigate('projects'),
        },
        {
          id: 'manage',
          label: '管理分组',
          icon: <Settings2 className="size-3.5" aria-hidden />,
          onSelect: () => navigate('projects'),
        },
      ],
    },
  ];

  const label = allSelected
    ? '全部分组'
    : projectIds.length === 1
      ? (items.find((project) => project.id === projectIds[0])?.name ?? '1 个分组')
      : `${projectIds.length} 个分组`;

  return (
    <Menu
      width={240}
      groups={groups}
      trigger={({ open, toggle: onToggle }) => (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label="选择分组"
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body transition-colors duration-120 ease-out',
            allSelected
              ? 'border-border text-text-secondary hover:bg-bg-muted hover:text-text-primary'
              : 'border-primary bg-primary-light text-primary',
          )}
        >
          分组: {label}
          <MenuCaret open={open} />
        </button>
      )}
    />
  );
}
