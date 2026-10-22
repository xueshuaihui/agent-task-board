import { Dialog, EmptyState, ErrorCopy, Skeleton } from '@/components/ui';
import type { ClientDetectResult, WakeProbe } from '@/api/types';
import { InlineError } from '@/features/task-detail/ui-bits';
import { useClientEntrySelfTest } from './client-entry-queries';

/**
 * 自测弹窗：轮询 `GET /client-entries/self-test`，展示最近到达的 `wake_probe`。
 *
 * 口径：收到探针只证明 MCP 工具链路通，不证明入口规则一定生效；只有 `source` 与当前客户端
 * 匹配时才标「已自测」，缺失来源只能写「收到自检（未标注客户端）」。
 * 时间直接截 ISO 串显示，避免 SSR 与浏览器时区不一致。
 */

export interface SelfTestDialogProps {
  open: boolean;
  client: ClientDetectResult | null;
  onClose: () => void;
}

function probeSource(probe: WakeProbe, client: ClientDetectResult | null): string {
  if (client && probe.source === client.client) return `来自 ${client.label}（已自测）`;
  if (probe.source === null) return '收到自检（未标注客户端）';
  return `来自 ${probe.source}`;
}

export function SelfTestDialog({ open, client, onClose }: SelfTestDialogProps) {
  const query = useClientEntrySelfTest(open);
  const data = query.data;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`自测 · ${client?.label ?? '客户端入口'}`}
      size="form"
    >
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-body text-text-secondary">
          <li>确认该客户端的入口规则已安装，并重载/新开会话；</li>
          <li>在会话中发送「贾维斯，自检」；</li>
          <li>回到这里查看最近到达记录（每 3 秒刷新）。</li>
        </ol>

        {query.isPending ? (
          <Skeleton lines={4} />
        ) : query.isError ? (
          <InlineError text={<ErrorCopy error={query.error} />} />
        ) : (data?.probes.length ?? 0) === 0 ? (
          <EmptyState
            title="还没有收到自检"
            description="安装规则后，在新会话里发送「贾维斯，自检」。"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {data?.probes.map((probe) => (
              <li
                key={probe.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-control border border-border px-3 py-2 text-body"
              >
                <span className="font-mono text-code text-text-secondary">
                  {probe.receivedAt.replace('T', ' ').slice(0, 19)}
                </span>
                <span className="text-text-primary">{probeSource(probe, client)}</span>
                {probe.tokenName ? (
                  <span className="text-aux text-text-tertiary">Token：{probe.tokenName}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {data ? (
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-aux text-text-secondary">
            <span>
              MCP 端点：
              <span className="font-mono text-code break-all text-text-primary">
                {data.mcpEndpoint}
              </span>
            </span>
            <span>当前模式：{data.wakeMode === 'continuous' ? '连续' : '单次'}</span>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
