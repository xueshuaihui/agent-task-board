import { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { Button, Dialog, Field, Textarea } from '@/components/ui';
import { usePublishSkill } from './hooks';
import { McpDependencyEditor } from './mcp-dependency-editor';
import { danglingNexts, previewNextVersion } from './meta';
import type { Skill, SkillContent, SkillMcpDependency } from './types';

/**
 * 发布对话框（2.md 11.3）：版本号预览（semver patch 自增，仅 UI 预告，
 * 真实版本以后端返回为准）、变更说明、MCP 依赖声明编辑器、发布前检查清单。
 * 提交 = POST /versions（新版本并设 current，随版本带上 mcp_dependencies——
 * 契约补充，见 README）+ PATCH status=PUBLISHED（hooks.usePublishSkill 串联）。
 */

export interface PublishDialogProps {
  open: boolean;
  skill: Skill;
  content: SkillContent;
  onClose: () => void;
  onPublished: (skill: Skill) => void;
}

export function PublishDialog({ open, skill, content, onClose, onPublished }: PublishDialogProps) {
  const [changelog, setChangelog] = useState('');
  const [mcp, setMcp] = useState<SkillMcpDependency[]>(skill.mcp_dependencies);
  const publish = usePublishSkill((updated) => {
    onClose();
    onPublished(updated);
  });

  if (!open) return null;

  const nextVersion = previewNextVersion(skill.current_version);
  const brokenLinks = danglingNexts(content);
  const checks: { ok: boolean; text: string }[] = [
    { ok: Boolean(skill.name) && Boolean(skill.description), text: '元数据完整（名称、描述）' },
    { ok: Boolean(content.entryBlockId) && content.blocks.length > 0, text: '入口块与内容块存在' },
    { ok: brokenLinks.length === 0, text: '块连线合法（无悬空 next）' },
    { ok: mcp.every((item) => Boolean(item.server)), text: 'MCP 依赖已声明 server' },
  ];
  const allOk = checks.every((check) => check.ok);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="发布技能"
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!allOk}
            loading={publish.isPending}
            onClick={() => publish.mutate({ id: skill.id, content, changelog, mcp })}
          >
            提交发布 {nextVersion}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-text-primary">
          技能：{skill.name} · {skill.current_version} → <span className="text-primary">{nextVersion}</span>
        </p>
        <Field label="变更说明" hint="发布后进入版本历史，便于回滚时判断">
          <Textarea
            value={changelog}
            rows={3}
            placeholder="本次发布改了什么"
            onChange={(event) => setChangelog(event.target.value)}
          />
        </Field>
        <Field label="MCP 依赖声明">
          <McpDependencyEditor value={mcp} onChange={setMcp} />
        </Field>
        <div className="flex flex-col gap-1.5 rounded-card border border-border bg-bg-raised p-3">
          <p className="text-card-title text-text-secondary">发布前检查</p>
          {checks.map((check) => (
            <p key={check.text} className="flex items-center gap-2 text-aux">
              {check.ok ? (
                <Check className="size-3.5 text-status-done" />
              ) : (
                <AlertTriangle className="size-3.5 text-status-running" />
              )}
              <span className={check.ok ? 'text-text-secondary' : 'text-text-primary'}>{check.text}</span>
            </p>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
