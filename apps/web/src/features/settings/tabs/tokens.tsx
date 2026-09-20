import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Copy, Plus } from 'lucide-react';
import { apiBase, errorMessage, fieldErrorsOf, isApiError } from '@/api';
import { Button, Dialog, Input, Tooltip } from '@/components/ui';
import type { AgentToken, IssuedToken } from '@/api/types';
import { formatDateTime, formatRelative } from '@/lib/time';
import { ChipEditor } from '../components/chip-editor';
import { ConfirmDialog } from '../components/confirm-dialog';
import {
  FormError,
  RowActions,
  SettingRow,
  SettingsTable,
  SettingSection,
  TabHeader,
} from '../components/settings-ui';
import { splitTokens, useIssueToken, useRevokeToken, useTokens } from '../queries';
import { useCopy } from '../use-copy';
import { CAPABILITY_NAMESPACES, CAPABILITY_RE, TOKEN_NAME_RE } from '../utils';

/**
 * Token Tab（8.5 / 原型 7.3）。
 *
 * 一条硬约束：**明文只在 `POST /tokens` 的响应里出现一次**（服务端只存 `token_hash`）。
 * 所以生成对话框分两段——表单段与「已生成」段，第二段关掉即销毁，界面上不留任何
 * 可以再读一次的入口；列表也没有「查看」列，这不是保守设计而是接口能力的上限。
 */

const COLS = 'grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_128px_96px_84px_64px]';

const CAPABILITY_SUGGESTIONS = [
  'language:typescript',
  'language:java',
  'language:python',
  'framework:spring',
  'repo:monorepo',
  'tool:git',
  'tool:maven',
];

const REVOKE_COPY = '吊销后该 Agent 的请求会立刻返回 401，已持有的租约由回收定时器释放。已有执行记录保留。';

/** 20.5：能力集合是领取过滤的默认值，不是并发上限。原型 7.3 把这段话原样放在对话框里。 */
const CAPABILITY_NOTE =
  '这里的能力集是该 Token 的默认值。Agent 调用 claim_next_task 时也可以带能力参数，带了就以参数为准（20.5）。它不是并发上限——平台不设并发上限。';

type ClientKind = 'qoder' | 'claude' | 'codex' | 'cursor';

const CLIENTS: readonly { id: ClientKind; label: string }[] = [
  { id: 'qoder', label: 'Qoder' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

export function TokensTab() {
  const tokens = useTokens();
  const copy = useCopy();
  const issue = useIssueToken();
  const revoke = useRevokeToken();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [client, setClient] = useState<ClientKind>('qoder');
  const [showRevoked, setShowRevoked] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentToken | null>(null);

  const items = tokens.data?.items ?? [];
  const { active, revoked } = useMemo(() => splitTokens(items), [items]);

  const mcpUrl = `${apiBase()}/mcp`;

  const openForm = () => {
    setName('');
    setCapabilities([]);
    setNameError(null);
    setIssued(null);
    issue.reset();
    setDialogOpen(true);
  };

  // 关闭即销毁明文：下一次打开只能是空白表单，不存在「回退到上一段」的路径。
  const closeDialog = () => {
    setDialogOpen(false);
    setIssued(null);
    issue.reset();
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!TOKEN_NAME_RE.test(trimmed) || trimmed.length < 2 || trimmed.length > 32) {
      setNameError('名称 2–32 位，小写字母或数字开头，可含 `-` 与 `_`（13 章）');
      return;
    }
    setNameError(null);
    issue.mutate({ name: trimmed, capabilities }, {
      onSuccess: (data) => {
        setIssued(data);
        setClient('qoder');
      },
    });
  };

  const confirmRevoke = () => {
    if (!revokeTarget) return;
    revoke.mutate(
      { id: revokeTarget.id },
      {
        onSuccess: () => {
          setRevokeTarget(null);
        },
      },
    );
  };

  const issueError = issue.error
    ? `${errorMessage(issue.error)}${describeFieldErrors(issue.error)}`
    : null;

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="Agent 接入"
        action={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={openForm}>
            生成 Token
          </Button>
        }
        description="Token 是机器本地的凭证：服务端只存哈希，导入导出不含 Token 表（6.12.1），换机后需重新生成。"
      />

      <SettingSection bare>
        <SettingsTable
          cols={COLS}
          head={['名称', '能力集', '创建时间', '最后使用', '状态', '操作']}
          items={showRevoked ? items : active}
          rowKey={(item) => item.id}
          rowTone={(item) => (item.enabled ? undefined : 'muted')}
          cells={(item) => [
            <span key="name" className="truncate font-mono text-code text-text-primary">
              {item.name}
            </span>,
            <span key="caps" className="flex flex-wrap gap-1">
              {item.capabilities.length === 0 ? (
                <span className="text-aux text-text-tertiary">—</span>
              ) : (
                item.capabilities.map((capability) => (
                  <span
                    key={capability}
                    className="rounded-tag bg-bg-muted px-1.5 py-px text-badge text-text-secondary"
                  >
                    {capability}
                  </span>
                ))
              )}
            </span>,
            <span key="created" className="text-aux text-text-secondary">
              {formatDateTime(item.created_at)}
            </span>,
            <Tooltip key="used" content={formatDateTime(item.last_used_at)}>
              <span className="block truncate text-aux text-text-secondary">
                {item.last_used_at ? formatRelative(item.last_used_at) : '从未使用'}
              </span>
            </Tooltip>,
            <span key="state" className="inline-flex items-center gap-1.5 text-aux">
              {item.enabled ? (
                <>
                  <span className="size-2 rounded-full bg-status-done" aria-hidden />
                  <span className="text-text-secondary">有效</span>
                </>
              ) : (
                <>
                  <span className="size-2 rounded-full border border-border-strong" aria-hidden />
                  <span className="text-text-tertiary">已吊销</span>
                </>
              )}
            </span>,
            item.enabled ? (
              <RowActions key="actions">
                <Button
                  size="sm"
                  variant="outlineDanger"
                  onClick={() => setRevokeTarget(item)}
                >
                  吊销
                </Button>
              </RowActions>
            ) : (
              <span key="actions" className="text-aux text-text-tertiary">
                —
              </span>
            ),
          ]}
          empty={
            <p className="text-aux text-text-secondary">
              还没有 Token。生成一个后把它填进 Agent 客户端的 MCP 配置，Agent 才能领取任务。
            </p>
          }
        />
        {revoked.length > 0 ? (
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-aux text-text-secondary hover:text-text-primary"
            onClick={() => setShowRevoked((value) => !value)}
          >
            {showRevoked ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showRevoked ? '收起' : `显示 ${revoked.length} 个已吊销`}
          </button>
        ) : null}
        <p className="mt-1 text-aux text-text-tertiary">
          已吊销项保留展示、不提供重新启用（Run 归属要看得懂）；要恢复接入就新建一个 Token。
        </p>
      </SettingSection>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={`吊销 Token「${revokeTarget?.name ?? ''}」`}
        description={REVOKE_COPY}
        detail="吊销不可撤销：该 Token 的明文立即失效，且列表里不会给它任何“恢复”按钮。"
        confirmText="吊销"
        danger
        loading={revoke.isPending}
        onConfirm={confirmRevoke}
        onClose={() => setRevokeTarget(null)}
      />

      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        title={issued ? 'Token 已生成' : '生成 Token'}
        dismissible={!issued}
        footer={
          issued ? (
            <Button variant="primary" onClick={closeDialog}>
              我已保存
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDialog}>
                取消
              </Button>
              <Button variant="primary" loading={issue.isPending} onClick={submit}>
                生成
              </Button>
            </>
          )
        }
      >
        {issued ? (
          <IssuedPanel
            issued={issued}
            mcpUrl={mcpUrl}
            client={client}
            onClient={setClient}
            copy={copy}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <SettingRow label="名称" required width="fluid" error={nameError}>
              <Input
                value={name}
                invalid={Boolean(nameError)}
                maxLength={32}
                placeholder="qoder-2"
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
              />
            </SettingRow>

            <SettingRow
              label="能力集（可选）"
              width="fluid"
              hint={`命名空间：${CAPABILITY_NAMESPACES.join(' / ')}；格式 \`namespace:value\`（20.5），留空表示不声明能力。`}
            >
              <ChipEditor
                values={capabilities}
                max={20}
                maxEach={64}
                addLabel="添加能力"
                placeholder="language:typescript"
                validate={(raw) =>
                  CAPABILITY_RE.test(raw) ? null : '能力标识需为 namespace:value（命名空间小写 ASCII）'
                }
                onChange={setCapabilities}
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {CAPABILITY_SUGGESTIONS.filter(
                  (item) => !capabilities.some((held) => held.toLowerCase() === item),
                ).map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="rounded-tag border border-dashed border-border px-1.5 py-px text-badge text-text-tertiary hover:border-primary hover:text-primary"
                    onClick={() => setCapabilities([...capabilities, item])}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </SettingRow>

            <p className="flex gap-2 rounded-control bg-primary-light px-3 py-2 text-aux text-text-secondary">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-running" />
              <span>{CAPABILITY_NOTE}</span>
            </p>

            {issueError ? <FormError>{issueError}</FormError> : null}
          </div>
        )}
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------- 生成成功页（一次性） */

interface IssuedPanelProps {
  issued: IssuedToken;
  mcpUrl: string;
  client: ClientKind;
  onClient: (client: ClientKind) => void;
  copy: (text: string, label: string) => Promise<void>;
}

function IssuedPanel({ issued, mcpUrl, client, onClient, copy }: IssuedPanelProps) {
  const snippet = clientSnippet(client, mcpUrl, issued.token);
  return (
    <div className="flex flex-col gap-4">
      <p className="flex gap-2 rounded-control bg-status-running-soft px-3 py-2 text-aux text-text-primary">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-status-running" />
        <span>明文只显示这一次，关闭后无法再查看——接口不会再返回它，列表里也没有「查看」。</span>
      </p>

      <div>
        <p className="select-all rounded-control border border-border bg-bg-muted px-3 py-2 font-mono text-code break-all text-text-primary">
          {issued.token}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => void copy(issued.token, 'Token')}
          >
            复制 Token
          </Button>
          <Button
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => void copy(mcpUrl, 'MCP 地址')}
          >
            复制 MCP 地址
          </Button>
        </div>
      </div>

      <div>
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-aux text-text-secondary">客户端配置片段</span>
          {CLIENTS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                item.id === client
                  ? 'rounded-control bg-primary px-2 py-0.5 text-badge text-text-inverse'
                  : 'rounded-control border border-border px-2 py-0.5 text-badge text-text-secondary hover:bg-bg-muted'
              }
              onClick={() => onClient(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <pre className="atb-scroll overflow-auto rounded-control border border-border bg-bg-muted px-3 py-2 font-mono text-code leading-relaxed text-text-primary">
          {snippet}
        </pre>
        <p className="mt-1 text-aux text-text-tertiary">{CLIENT_NOTES[client]}</p>
      </div>
    </div>
  );
}

/** 14 章首批四家：端点、Token、工具契约完全一致，差别只在配置写法与谁来触发轮询。 */
function clientSnippet(client: ClientKind, url: string, token: string): string {
  const auth = `Bearer ${token}`;
  if (client === 'qoder') {
    return JSON.stringify(
      { mcpServers: { 'agent-task-board': { url, headers: { Authorization: auth } } } },
      null,
      2,
    );
  }
  if (client === 'claude') {
    return `claude mcp add --transport http agent-task-board ${url} --header "Authorization: ${auth}"`;
  }
  if (client === 'codex') {
    return [
      '# ~/.codex/config.toml',
      '[mcp_servers.agent-task-board]',
      `url = "${url}"`,
      'bearer_token_env_var = "ATB_MCP_TOKEN"',
      '',
      '# 启动前：export ATB_MCP_TOKEN="atb_…（本次显示的明文）"',
    ].join('\n');
  }
  return JSON.stringify(
    { mcpServers: { 'agent-task-board': { url, headers: { Authorization: auth } } } },
    null,
    2,
  );
}

const CLIENT_NOTES: Record<ClientKind, string> = {
  qoder: 'Qoder：客户端内置定时任务周期调用 claim_next_task，无需额外调度。',
  claude: 'Claude Code：内置定时任务或 hooks 触发；配置写入代码仓库的 .mcp.json 同样有效。',
  codex: 'Codex：MCP 客户端配置在 config.toml；Token 走环境变量，别写进仓库。',
  cursor:
    'Cursor：没有到点自动调 MCP 工具的调度器——需外部调度（launchd / 任务计划程序）周期调用 REST POST /api/v1/tasks/claim，或在 .cursor/rules/*.mdc 写「会话开始先 list_ready_tasks」的规则；后者不是无人值守。且只支持本地会话（127.0.0.1 不对外暴露）。',
};

/** 422 的 `details.fields` 摊平进一句提示，表单不必为每个键各占一行。 */
function describeFieldErrors(error: unknown): string {
  if (!isApiError(error)) return '';
  const fields = fieldErrorsOf(error);
  const parts = Object.entries(fields).map(([key, message]) => `${key}：${message}`);
  return parts.length ? `（${parts.join('；')}）` : '';
}
