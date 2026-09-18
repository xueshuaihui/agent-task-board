import { cn } from '@/lib/cn';

/**
 * 15.3 的色点 + 项目自己的 emoji：卡片、切换器、迁移目标下拉共用一个「标识」渲染。
 * 无图标时退回色点；有 color 无 icon 是新建时的常态（色是必选、图标可选）。
 */
export function ProjectGlyph({ project, className }: { project: { color: string | null; icon: string | null }; className?: string }) {
  return (
    <span className={cn('inline-flex size-4 shrink-0 items-center justify-center text-aux', className)} aria-hidden>
      {project.icon ? (
        project.icon
      ) : (
        <span
          className="inline-block size-2.5 rounded-full"
          style={project.color ? { backgroundColor: project.color } : undefined}
        />
      )}
    </span>
  );
}
