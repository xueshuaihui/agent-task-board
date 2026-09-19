import { useState } from 'react';
import { AlertTriangle, Check, FlaskConical, Play } from 'lucide-react';
import { Button, Dialog, Field, Input, Textarea, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { usePatchSkill, usePublishSkill, useTestSkill } from './hooks';
import { McpDependencyEditor } from './mcp-dependency-editor';
import { cyclicBlockIds, danglingNexts, previewNextVersion, variableWarnings } from './meta';
import type { Skill, SkillContent, SkillMcpDependency } from './types';

/**
 * 发布对话框（2.md 11.3 + 1.md 8.6）：版本号预览（semver patch 自增，仅 UI 预告，
 * 真实版本以后端返回为准）、变更说明、MCP 依赖声明编辑器、发布前检查清单、
 * 测试状态展示 + 技能测试入口。
 *
 * 测试接缝（1.md 8.6「测试通过不是发布的硬性前置」）：
 * - 测试用例接口后端后续提供（建议契约：GET /skills/:id/test-cases →
 *   { items: [{ id, name, last_run?: { passed: boolean } }], total }，与版本一起版本化），
 *   就位后把下方 testCases 区块换成真实数据即可，展示结构已留好；
 * - 现在可用的「技能测试」走 POST /skills/:id/test 模拟运行（hooks.useTestSkill）。
 */

export interface PublishDialogProps {
  open: boolean;
  skill: Skill;
  content: SkillContent;
  onClose: () => void;
  onPublished: (skill: Skill) => void;
}

export function PublishDialog({ open, skill, content, onClose, onPublished }: PublishDialogProps) {
  const toast = useToast();
  const [changelog, setChangelog] = useState('');
  const [mcp, setMcp] = useState<SkillMcpDependency[]>(skill.mcp_dependencies);
  const [metaOpen, setMetaOpen] = useState(false);
  const [fixName, setFixName] = useState(skill.name);
  const [fixDescription, setFixDescription] = useState(skill.description);
  const [testOpen, setTestOpen] = useState(false);
  const [testInput, setTestInput] = useState('');
  const publish = usePublishSkill((updated) => {
    onClose();
    onPublished(updated);
  });
  const patchMeta = usePatchSkill(() => setMetaOpen(false));
  const test = useTestSkill((result) => {
    if (result.ok) toast.success('测试运行通过', result.output || undefined);
    else toast.error('测试运行失败', result.output || result.logs.join('\n') || undefined);
  });

  if (!open) return null;

  const nextVersion = previewNextVersion(skill.current_version);
  const brokenLinks = danglingNexts(content);
  const cycles = cyclicBlockIds(content);
  const varWarnings = variableWarnings(content);
  const metaMissingDescription = !skill.description;

  /** level=error 阻断发布；level=warn 只提示（如变量拼写、测试未通过）。 */
  const checks: { ok: boolean; text: string; level: 'error' | 'warn' }[] = [
    { ok: Boolean(skill.name) && Boolean(skill.description), text: '元数据完整（名称、描述）', level: 'error' },
    { ok: Boolean(content.entryBlockId) && content.blocks.length > 0, text: '入口块与内容块存在', level: 'error' },
    { ok: brokenLinks.length === 0, text: '块连线合法（无悬空 next）', level: 'error' },
    { ok: cycles.size === 0, text: '无循环引用（next 指针成环）', level: 'error' },
    { ok: mcp.every((item) => Boolean(item.server)), text: 'MCP 依赖已声明 server', level: 'error' },
    {
      ok: varWarnings.length === 0,
      text: varWarnings.length === 0 ? '变量引用均可识别' : `变量拼写提示：${varWarnings.length} 处未声明引用（不阻断）`,
      level: 'warn',
    },
  ];
  const allOk = checks.filter((check) => check.level === 'error').every((check) => check.ok);

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

        {/* 测试状态（1.md 8.6）：展示区 + 技能测试入口。测试用例接口后端后续提供，
            就位后从 useQuery(GET /skills/:id/test-cases) 取数替换 testCasesTotal/Passed。 */}
        <div className="flex flex-col gap-2 rounded-card border border-border bg-bg-raised p-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="size-4 text-text-secondary" />
            <p className="text-card-title text-text-secondary">测试状态</p>
            <span className="ml-auto text-aux text-text-tertiary">
              测试用例 (-- · 通过 --) {/* 接缝：用例接口就位后改为 `测试用例 (${total} · 通过 ${passed})` */}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setTestOpen((prev) => !prev)}>
              {testOpen ? '收起测试' : '技能测试'}
            </Button>
          </div>
          <p className="text-aux text-text-tertiary">
            测试通过不是发布的硬性前置；测试用例随技能版本一起版本化（用例接口就位后在此展示最近一次结果）。
          </p>
          {testOpen ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  value={testInput}
                  placeholder="模拟运行的输入（如一段 diff 或指令）"
                  className="h-8 flex-1 text-aux"
                  onChange={(event) => setTestInput(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="default"
                  icon={<Play className="size-3.5" />}
                  loading={test.isPending}
                  onClick={() => test.mutate({ id: skill.id, input: testInput })}
                >
                  运行
                </Button>
              </div>
              {test.data ? (
                <pre className="atb-scroll max-h-40 overflow-auto rounded-card border border-border bg-bg p-2 font-mono text-code text-text-secondary">
                  {test.data.logs.join('\n') || test.data.output}
                </pre>
              ) : null}
              {test.isError ? <p className="text-aux text-status-failed">{errorMessage(test.error)}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5 rounded-card border border-border bg-bg-raised p-3">
          <p className="text-card-title text-text-secondary">发布前检查</p>
          {checks.map((check) => (
            <div key={check.text} className="flex flex-col gap-1.5">
              <p className="flex items-center gap-2 text-aux">
                {check.ok ? (
                  <Check className="size-3.5 text-status-done" />
                ) : (
                  <AlertTriangle className={check.level === 'error' ? 'size-3.5 text-status-failed' : 'size-3.5 text-status-running'} />
                )}
                <span
                  className={
                    check.ok
                      ? 'text-text-secondary'
                      : check.level === 'error'
                        ? 'text-status-failed'
                        : 'text-status-running'
                  }
                >
                  {check.text}
                </span>
                {check.text === '元数据完整（名称、描述）' && !check.ok ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => {
                      setFixName(skill.name);
                      setFixDescription(skill.description);
                      setMetaOpen((prev) => !prev);
                    }}
                  >
                    {metaOpen ? '收起' : '就地补齐'}
                  </Button>
                ) : null}
              </p>
              {check.text === '元数据完整（名称、描述）' && !check.ok && metaOpen ? (
                <div className="flex flex-col gap-2 rounded-card border border-border bg-bg p-3">
                  <Field label="名称" htmlFor="publish-fix-name">
                    <Input
                      id="publish-fix-name"
                      value={fixName}
                      onChange={(event) => setFixName(event.target.value)}
                    />
                  </Field>
                  <Field label="描述" htmlFor="publish-fix-desc">
                    <Textarea
                      id="publish-fix-desc"
                      value={fixDescription}
                      rows={3}
                      placeholder="这个技能解决什么问题、怎么用"
                      onChange={(event) => setFixDescription(event.target.value)}
                    />
                  </Field>
                  <Button
                    variant="default"
                    size="sm"
                    className="self-start"
                    disabled={!fixName.trim()}
                    loading={patchMeta.isPending}
                    onClick={() =>
                      patchMeta.mutate({
                        id: skill.id,
                        body: {
                          name: fixName.trim(),
                          description: fixDescription.trim(),
                        },
                      })
                    }
                  >
                    保存
                  </Button>
                  {metaMissingDescription ? (
                    <p className="text-aux text-text-tertiary">保存后检查自动通过；也可稍后在编辑器补齐描述。</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
