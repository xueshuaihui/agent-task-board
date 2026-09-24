import { useState } from 'react';
import { Copy, Download, FolderOpen, History, Play, RotateCcw } from 'lucide-react';
import { Badge, Button, Drawer, EmptyState, Field, Skeleton, Tabs, TagBadge, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/time';
import { skillsApi } from './api';
import { useRollbackSkill, useSkill, useSkillBoundTasks, useTestSkill } from './hooks';
import { categoryDisplay } from './skill-picker-core';
import { BLOCK_KIND_META, SKILL_ORIGIN_META, SKILL_STATUS_META, SKILL_TYPE_META } from './meta';
import type { Skill } from './types';

/**
 * 技能详情抽屉（2.md 第十三章，本地技能版）：
 * 概览（内容块预览）/ 版本（回滚）/ 测试（输入→运行→logs/output）/
 * MCP 依赖（配置片段复制）/ 绑定任务。导出 .atskill 在头部。
 *
 * 接缝：任务详情「技能标签」、看板卡片技能角标可直接挂本抽屉（README 有说明）。
 */

export interface SkillDetailDrawerProps {
  skillId: string | undefined;
  open: boolean;
  onClose: () => void;
  onEdit?: (skill: Skill) => void;
}

export function SkillDetailDrawer({ skillId, open, onClose, onEdit }: SkillDetailDrawerProps) {
  const [tab, setTab] = useState('overview');
  const query = useSkill(open ? skillId : undefined);
  const skill = query.data;
  const status = skill ? SKILL_STATUS_META[skill.status] : undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {skill?.name ?? '技能详情'}
          {skill ? (
            <span className="text-aux tabular-nums text-text-tertiary">
              {SKILL_TYPE_META[skill.type]?.label ?? skill.type} · {skill.current_version} ·{' '}
              {SKILL_ORIGIN_META[skill.source]?.label ?? skill.source}
            </span>
          ) : null}
        </span>
      }
      headerExtra={
        /* 常规流容器：Tabs 的 className 现作用于 List（-mx-5 让下边框通铺、
           List 自带 px-5 让页签与父级内容对齐），不再依赖 Root flex-1 拉伸。 */
        <div className="px-5 pb-3">
          <Tabs
            variant="underline"
            value={tab}
            onChange={setTab}
            ariaLabel="技能详情分区"
            items={[
              { value: 'overview', label: '概览' },
              { value: 'versions', label: '版本' },
              { value: 'test', label: '测试' },
              { value: 'mcp', label: 'MCP 依赖' },
              { value: 'tasks', label: '绑定任务' },
            ]}
            className="-mx-5 flex-1"
          />
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          {skill && onEdit ? (
            /* W2：默认技能只读，入口文案改「查看」（编辑器内无保存/发布）。 */
            <Button size="sm" onClick={() => onEdit(skill)}>
              {skill.readonly ? '查看' : '编辑'}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="default"
            icon={<Download className="size-4" />}
            disabled={!skill}
            onClick={() => {
              if (skill) skillsApi.export(skill.id, skill.name).catch(() => undefined);
            }}
          >
            导出 .atskill
          </Button>
        </div>
      }
    >
      {!skill ? (
        <div className="flex flex-col gap-3 px-5 py-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-5 py-4">
          {/* C-6b①：分类独立成行、与 tags 分区——口径与筛选器/卡片同源
              （直读 skill.category，未分类走 UNCATEGORIZED_LABEL），不从 tags 推导。 */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-aux text-text-tertiary">分类</span>
            <Badge tone="neutral" icon={<FolderOpen className="size-3" aria-hidden />}>
              {categoryDisplay(skill)}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-badge px-2 py-0.5 text-badge', status?.className)}>
              {status?.label}
            </span>
            {skill.tags.map((tag) => (
              <TagBadge key={tag}>{tag}</TagBadge>
            ))}
          </div>

          {tab === 'overview' ? <OverviewTab skill={skill} /> : null}
          {tab === 'versions' ? <VersionsTab skill={skill} /> : null}
          {tab === 'test' ? <TestTab skillId={skill.id} /> : null}
          {tab === 'mcp' ? <McpTab skill={skill} /> : null}
          {tab === 'tasks' ? <TasksTab skillId={skill.id} /> : null}
        </div>
      )}
    </Drawer>
  );
}

function OverviewTab({ skill }: { skill: Skill }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-text-secondary">{skill.description || '（暂无描述）'}</p>
      <div className="flex flex-col gap-2">
        <p className="text-card-title text-text-secondary">内容块预览</p>
        {(skill.content?.blocks ?? []).map((block, index) => {
          const meta = BLOCK_KIND_META[block.kind];
          return (
            <div key={block.id} className="rounded-card border border-border bg-bg-raised p-3">
              <div className="flex items-center gap-2">
                <span className={cn('rounded-tag px-1.5 py-0.5 text-badge', meta.kindClass)}>
                  {meta.label}
                </span>
                <p className="text-card-title text-text-primary">
                  {index + 1}. {block.title || meta.label}
                  {skill.content?.entryBlockId === block.id ? (
                    <span className="ml-2 text-aux text-primary">入口</span>
                  ) : null}
                </p>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-aux text-text-secondary">
                {meta.summary(block) || '（无内容）'}
              </p>
            </div>
          );
        })}
      </div>
      <p className="text-aux text-text-tertiary">
        创建于 {formatDateTime(skill.created_at)} · 更新于 {formatDateTime(skill.updated_at)}
      </p>
    </div>
  );
}

function VersionsTab({ skill }: { skill: Skill }) {
  const toast = useToast();
  const rollback = useRollbackSkill((updated) => {
    toast.success('已回滚', `当前版本 ${updated.current_version}`);
  });
  const versions = skill.versions ?? [];

  if (versions.length === 0) {
    return <EmptyState title="暂无版本记录" description="发布第一个版本后会出现在这里" />;
  }

  return (
    <div className="flex flex-col gap-2">
      {versions.map((version) => (
        <div
          key={version.version}
          className="flex items-center gap-3 rounded-card border border-border bg-bg-raised px-3 py-2.5"
        >
          <History className="size-4 shrink-0 text-text-tertiary" />
          <div className="min-w-0 flex-1">
            <p className="text-card-title tabular-nums text-text-primary">
              {version.version}
              {version.current ? <span className="ml-2 text-aux text-primary">当前</span> : null}
            </p>
            <p className="truncate text-aux text-text-tertiary">
              {version.changelog || '无变更说明'} · {formatDateTime(version.created_at)}
            </p>
          </div>
          {!version.current ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw className="size-4" />}
              loading={rollback.isPending}
              onClick={() => {
                if (window.confirm(`回滚到 ${version.version}？当前版本内容将被覆盖`)) {
                  rollback.mutate({ id: skill.id, version: version.version });
                }
              }}
            >
              回滚到此版
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TestTab({ skillId }: { skillId: string }) {
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState<{ ok: boolean; logs: string[]; output: string } | null>(null);
  const toast = useToast();
  const test = useTestSkill();

  return (
    <div className="flex flex-col gap-3">
      <Field label="模拟输入" hint="JSON 对象，运行不会产生真实副作用">
        <Textarea value={input} rows={4} className="font-mono" onChange={(event) => setInput(event.target.value)} />
      </Field>
      <Button
        variant="primary"
        size="sm"
        className="self-start"
        icon={<Play className="size-4" />}
        loading={test.isPending}
        onClick={() =>
          test.mutate(
            { id: skillId, input },
            {
              onSuccess: (data) => setResult(data),
              onError: (error) => toast.error('运行失败', errorMessage(error)),
            },
          )
        }
      >
        运行
      </Button>
      {result ? (
        <div className="flex flex-col gap-2">
          <p className={cn('text-card-title', result.ok ? 'text-status-done' : 'text-status-failed')}>
            {result.ok ? '运行成功' : '运行失败'}
          </p>
          <pre className="atb-scroll max-h-40 overflow-auto rounded-card border border-border bg-bg-raised p-3 font-mono text-code text-text-secondary">
            {result.logs.join('\n') || '（无日志）'}
          </pre>
          <pre className="atb-scroll max-h-40 overflow-auto rounded-card border border-border bg-bg-raised p-3 font-mono text-code text-text-secondary">
            {result.output || '（无输出）'}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function McpTab({ skill }: { skill: Skill }) {
  const toast = useToast();
  const deps = skill.mcp_dependencies ?? [];

  if (deps.length === 0) {
    return <EmptyState title="未声明 MCP 依赖" description="发布时可在发布对话框中声明" />;
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      toast.success('已复制配置片段');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {deps.map((dep, index) => (
        <div key={index} className="rounded-card border border-border bg-bg-raised p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-card-title text-text-primary">
              {dep.server}
              <span className="ml-2 text-aux text-text-tertiary">
                {dep.required ? '必需' : '可选'}
              </span>
            </p>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="size-4" />}
              onClick={() =>
                copy(
                  JSON.stringify(
                    {
                      mcpServers: {
                        [dep.server]: { tools: dep.tools, required: dep.required, ...(dep.reason ? { reason: dep.reason } : {}) },
                      },
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              复制配置片段
            </Button>
          </div>
          <p className="mt-1 text-aux text-text-secondary">工具：{dep.tools.join('、') || '（未声明）'}</p>
          {dep.reason ? <p className="text-aux text-text-tertiary">{dep.reason}</p> : null}
        </div>
      ))}
    </div>
  );
}

function TasksTab({ skillId }: { skillId: string }) {
  const query = useSkillBoundTasks(skillId);

  if (query.isPending) {
    return <Skeleton className="h-24 w-full" />;
  }
  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return <EmptyState title="暂无绑定任务" description="在任务详情的技能标签中绑定此技能" />;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map((task) => (
        <div
          key={task.id}
          className="flex items-center justify-between rounded-card border border-border bg-bg-raised px-3 py-2.5"
        >
          <p className="truncate text-card-title text-text-primary">{task.title}</p>
          <span className="shrink-0 text-aux tabular-nums text-text-tertiary">{task.status}</span>
        </div>
      ))}
    </div>
  );
}
