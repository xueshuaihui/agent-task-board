import { useMemo, useState } from 'react';
import { ChevronDown, Copy, FileCode2, FileText, Package, Plus, Search, Sparkles, Upload } from 'lucide-react';
import {
  Button,
  CardSkeleton,
  EmptyState,
  Input,
  Menu,
  Select,
  useToast,
} from '@/components/ui';
import { errorMessage } from '@/api';
import { blocksToMarkdown } from './markdown';
import { skillsApi } from './api';
import { CreateSkillDialog } from './create-skill-dialog';
import { CopySkillPicker } from './copy-skill-picker';
import { ImportCenterDialog } from './import-center-dialog';
import { MarketPublishDialog } from '@/features/market';
import { useCreateSkill, useDeleteSkill, useSkills } from './hooks';
import { SKILL_STARTER_TEMPLATES, SKILL_STATUS_META, SKILL_TYPE_OPTIONS } from './meta';
import { SkillCard } from './skill-card';
import { SkillDetailDrawer } from './skill-detail-drawer';
import { SkillEditorPage } from './skill-editor-page';
import type { Skill, SkillQuery, SkillStatus, SkillType } from './types';

/**
 * 技能库页（2.md 10.1/10.2）。路由：`#/skills`；编辑器以查询参数挂载
 * `#/skills?edit=<skillId>`（hash 自研路由只认命名路由，见 README「路由接线」）。
 *
 * 创建入口统一在「新建技能 ▾」下拉：空白新建 / 从模板起步 / 导入 .atskill /
 * 导入 SKILL.md / 从 Cursor Rules 导入 / 复制现有技能；空库时展示三张大卡引导。
 */

const LIBRARY_PATH = '/skills';

function libraryHref(search: string): string {
  return `#${LIBRARY_PATH}${search}`;
}

export function SkillLibraryPage() {
  const toast = useToast();
  const [keywordInput, setKeywordInput] = useState('');
  const [type, setType] = useState<SkillType | ''>('');
  const [status, setStatus] = useState<SkillStatus | ''>('');

  /* `?edit=` 挂编辑器；其余查询参数留给后续（如 tag 深链）。 */
  const search = typeof window !== 'undefined' ? window.location.hash.split('?')[1] ?? '' : '';
  const editingId = new URLSearchParams(search).get('edit');

  const query: SkillQuery = useMemo(
    () => ({ keyword: keywordInput || undefined, type: type || undefined, status: status || undefined }),
    [keywordInput, type, status],
  );
  const skills = useSkills(query);

  const [createOpen, setCreateOpen] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<string | null | undefined>(undefined);
  const [marketPublishSkill, setMarketPublishSkill] = useState<Skill | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSource, setImportSource] = useState<'atskill' | 'markdown' | 'cursor-rules' | undefined>(undefined);
  const [copyPickerOpen, setCopyPickerOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | undefined>(undefined);
  const remove = useDeleteSkill();
  const copyCreate = useCreateSkill((skill) => {
    toast.success('已复制技能', `已创建「${skill.name}」，可继续编辑`);
    openEditor(skill);
  });

  const openEditor = (skill: Skill) => {
    window.location.hash = libraryHref(`?edit=${encodeURIComponent(skill.id)}`);
  };
  const closeEditor = () => {
    window.location.hash = libraryHref('');
  };

  /** 复制：GET /skills/:id 拿全量内容后 POST /skills 建副本。 */
  const copySkill = (skill: Skill) => {
    skillsApi
      .get(skill.id)
      .then((full) =>
        copyCreate.mutate({
          name: `${full.name} 副本`,
          type: full.type,
          description: full.description,
          tags: [...full.tags],
          content: full.content,
        }),
      )
      .catch((error) => toast.error('复制失败', errorMessage(error)));
  };

  /** SKILL.md 导出：markdown.ts 的 blocksToMarkdown 直接生成下载。 */
  const exportMarkdown = (skill: Skill) => {
    const markdown = blocksToMarkdown(skill.content, {
      name: skill.name,
      description: skill.description,
      version: skill.current_version,
      category: skill.type,
      tags: skill.tags,
      mcpDependencies: skill.mcp_dependencies,
    });
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${skill.name || 'skill'}.SKILL.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('已导出 SKILL.md');
  };

  const confirmDelete = (skill: Skill) => {
    const boundCount = skill.stats?.bound_task_count ?? 0;
    const suffix =
      boundCount > 0
        ? `该技能仍被 ${boundCount} 个任务绑定，删除后这些任务将失去该技能引用`
        : '该技能暂无任务绑定';
    if (window.confirm(`删除技能「${skill.name}」？${suffix}。此操作不可撤销`)) {
      remove.mutate(skill.id, {
        onError: (error) => toast.error('删除失败', errorMessage(error)),
      });
    }
  };

  const createMenu = (
    <Menu
      width={230}
      align="end"
      trigger={({ toggle }) => (
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={toggle}>
          新建技能
          <ChevronDown className="ml-0.5 size-4 opacity-70" />
        </Button>
      )}
      groups={[
        {
          items: [
            {
              id: 'blank',
              label: '空白新建',
              icon: <Plus className="size-4" />,
              onSelect: () => {
                setCreateTemplateId(null);
                setCreateOpen(true);
              },
            },
            {
              id: 'template',
              label: '从模板起步',
              hint: `${SKILL_STARTER_TEMPLATES.length} 个内置模板`,
              icon: <Sparkles className="size-4" />,
              onSelect: () => {
                setCreateTemplateId(undefined);
                setCreateOpen(true);
              },
            },
          ],
        },
        {
          label: '导入',
          items: [
            {
              id: 'import-atskill',
              label: '导入 .atskill',
              icon: <Package className="size-4" />,
              onSelect: () => {
                setImportSource('atskill');
                setImportOpen(true);
              },
            },
            {
              id: 'import-md',
              label: '导入 SKILL.md',
              icon: <FileText className="size-4" />,
              onSelect: () => {
                setImportSource('markdown');
                setImportOpen(true);
              },
            },
            {
              id: 'import-mdc',
              label: '从 Cursor Rules 导入',
              icon: <FileCode2 className="size-4" />,
              onSelect: () => {
                setImportSource('cursor-rules');
                setImportOpen(true);
              },
            },
          ],
        },
        {
          items: [
            {
              id: 'copy',
              label: '复制现有技能',
              icon: <Copy className="size-4" />,
              onSelect: () => setCopyPickerOpen(true),
            },
          ],
        },
      ]}
    />
  );

  if (editingId) {
    return (
      <>
        <SkillEditorPage
          skillId={editingId}
          onClose={closeEditor}
          onOpenDetail={(skill) => setDetailId(skill.id)}
        />
        <SkillDetailDrawer
          skillId={detailId}
          open={Boolean(detailId)}
          onClose={() => setDetailId(undefined)}
          onEdit={(skill) => {
            setDetailId(undefined);
            openEditor(skill);
          }}
        />
      </>
    );
  }

  const filtersActive = Boolean(keywordInput || type || status);
  const isEmptyLibrary = !filtersActive && (skills.data?.items.length ?? 0) === 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-page-title text-text-primary">技能库</h1>
          <p className="text-aux text-text-secondary">
            {skills.data ? `${skills.data.total} 个技能` : '本地技能与流程编排'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {createMenu}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] max-w-[360px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            value={keywordInput}
            placeholder="搜索名称、描述、标签…"
            className="w-full pl-8"
            onChange={(event) => setKeywordInput(event.target.value)}
          />
        </div>
        <Select
          className="w-36"
          value={type}
          placeholder="全部类型"
          options={[{ value: '', label: '全部类型' }, ...SKILL_TYPE_OPTIONS]}
          onChange={(event) => setType(event.target.value as SkillType | '')}
        />
        <Select
          className="w-36"
          value={status}
          placeholder="全部状态"
          options={[
            { value: '', label: '全部状态' },
            ...(Object.keys(SKILL_STATUS_META) as SkillStatus[]).map((value) => ({
              value,
              label: SKILL_STATUS_META[value].label,
            })),
          ]}
          onChange={(event) => setStatus(event.target.value as SkillStatus | '')}
        />
      </div>

      {skills.isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : skills.isError ? (
        <EmptyState
          title="技能库加载失败"
          description={errorMessage(skills.error)}
          action={
            <Button size="sm" onClick={() => skills.refetch()}>
              重试
            </Button>
          }
        />
      ) : isEmptyLibrary ? (
        /* 空库引导：三张大卡，对齐成熟产品的空状态。 */
        <EmptyLibraryGuide
          onStartTemplate={() => {
            setCreateTemplateId(undefined);
            setCreateOpen(true);
          }}
          onImport={() => {
            setImportSource(undefined);
            setImportOpen(true);
          }}
          onBlank={() => {
            setCreateTemplateId(null);
            setCreateOpen(true);
          }}
          onCopy={() => setCopyPickerOpen(true)}
        />
      ) : (skills.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="没有匹配的技能"
          description="试试放宽筛选条件"
          action={
            <Button
              size="sm"
              onClick={() => {
                setKeywordInput('');
                setType('');
                setStatus('');
              }}
            >
              清除筛选
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(248px,1fr))] gap-3">
          {skills.data.items.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onOpen={(target) => setDetailId(target.id)}
              onEdit={openEditor}
              onPublish={openEditor}
              onPublishToMarket={(target) => setMarketPublishSkill(target)}
              onExport={(target) => {
                skillsApi
                  .export(target.id, target.name)
                  .catch((error) => toast.error('导出失败', errorMessage(error)));
              }}
              onExportMarkdown={exportMarkdown}
              onCopy={copySkill}
              onDelete={confirmDelete}
            />
          ))}
        </div>
      )}

      <MarketPublishDialog
        open={marketPublishSkill !== null}
        skillId={marketPublishSkill?.id ?? ''}
        onClose={() => setMarketPublishSkill(null)}
      />
      <CreateSkillDialog
        open={createOpen}        onClose={() => setCreateOpen(false)}
        onCreated={(skill) => {
          toast.success('已创建，开始编辑', `「${skill.name}」已创建为草稿`);
          openEditor(skill);
        }}
        initialTemplateId={createTemplateId}
      />
      <ImportCenterDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(skill) => {
          setImportOpen(false);
          setDetailId(skill.id);
        }}
        existingNames={(skills.data?.items ?? []).map((item) => item.name)}
        initialSource={importSource}
      />
      <CopySkillPicker
        open={copyPickerOpen}
        onClose={() => setCopyPickerOpen(false)}
        onPicked={copySkill}
      />
      <SkillDetailDrawer
        skillId={detailId}
        open={Boolean(detailId)}
        onClose={() => setDetailId(undefined)}
        onEdit={(skill) => {
          setDetailId(undefined);
          openEditor(skill);
        }}
      />
    </div>
  );
}

function EmptyLibraryGuide({
  onStartTemplate,
  onImport,
  onBlank,
  onCopy,
}: {
  onStartTemplate: () => void;
  onImport: () => void;
  onBlank: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <GuideCard
          icon={<Sparkles className="size-5" />}
          title="从模板开始"
          description="8 个内置场景模板（代码审查、Bug 定位、周报…），选一个改改就能用"
          actionLabel="浏览模板"
          onClick={onStartTemplate}
          emphasized
        />
        <GuideCard
          icon={<Upload className="size-5" />}
          title="导入"
          description="支持 .atskill、SKILL.md、Cursor Rules .mdc，解析预览后再创建"
          actionLabel="导入文件"
          onClick={onImport}
        />
        <GuideCard
          icon={<Plus className="size-5" />}
          title="空白创建"
          description="从一个入口块开始，自由编排提示词、步骤与流程"
          actionLabel="空白新建"
          onClick={onBlank}
        />
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="mx-auto flex items-center gap-1.5 rounded-control px-3 py-1.5 text-aux text-text-tertiary transition-colors hover:bg-bg-raised hover:text-text-primary"
      >
        <Copy className="size-3.5" />
        或者复制一个现有技能
      </button>
    </div>
  );
}

function GuideCard({
  icon,
  title,
  description,
  actionLabel,
  onClick,
  emphasized,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
  emphasized?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex flex-col gap-2 rounded-card border bg-bg-surface p-5 text-left shadow-card transition-colors hover:bg-bg-raised ' +
        (emphasized ? 'border-primary/60' : 'border-border hover:border-primary/40')
      }
    >
      <span
        className={
          'flex size-9 items-center justify-center rounded-tag ' +
          (emphasized ? 'bg-primary-light text-primary' : 'bg-bg-muted text-text-secondary')
        }
      >
        {icon}
      </span>
      <span className="text-card-title text-text-primary">{title}</span>
      <span className="text-aux text-text-secondary">{description}</span>
      <span className="mt-1 text-body text-primary">{actionLabel} →</span>
    </button>
  );
}

/** 顶栏导航候选：主 agent 接线时并入 ROUTES 即可（README）。 */
export const skillsRouteCandidate = { path: LIBRARY_PATH, label: '技能' } as const;
