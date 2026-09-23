import { useRef } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { Button, Dialog, EmptyState, Skeleton } from '@/components/ui';
import { errorMessage } from '@/api';
import { desktop } from '@/app/desktop';
import { useArtifactMeta } from '../queries';
import { COPY } from '@/lib/copy';
import { ARTIFACT_TYPE_LABEL, labelOf } from '@/lib/labels';
import { formatBytes } from '@/lib/time';
import { previewTooLargeText, TOO_LARGE_HINT } from '../labels';
import type { PreviewTarget } from '../types';
import { DiffViewer } from './diff-viewer';
import { ImageViewer } from './image-viewer';
import { TextViewer } from './text-viewer';
import { downloadArtifact, useArtifactText } from './use-artifact-content';

/**
 * 产物预览框（原型 9.1–9.4）。
 *
 * 容器复用 `Dialog` 的 720px 档（1.5 只给了 560/720 两档宽度，预览器不新造第三档），
 * z-50 盖在抽屉（z-40）之上。判定顺序照 13 章 + 6.10.3：
 * 先看 `missing`（灰态、不给按钮），再看 `preview.enabled`（超大只给下载），最后才选渲染器。
 * `missing` 有两个同口径来源：产物列表行带上来的 `target.missing`（验收 42：列表里就已标出）
 * 与元信息接口的判定，前者让框打开即落灰态、不必等一次请求。
 *
 * `link` 是唯一的例外：它不占磁盘（20.6），服务端 `requireFile` 对它的 `/raw` 直接 404，
 * 所以整框**只有一个动作**——按 6.10.1 把 `uri` 交系统默认浏览器，footer 的下载不给它。
 */

export interface ArtifactPreviewDialogProps {
  target: PreviewTarget | null;
  maxMb: number;
  onClose: () => void;
}

export function ArtifactPreviewDialog({ target, maxMb, onClose }: ArtifactPreviewDialogProps) {
  // 退场动画接线（统一套路）：ref 保留末次非空 target + open 受控——target 变 null 时不卸载，
  // Dialog 经历 true→false 过渡帧播 140ms 退场；标题/正文仍是刚才那份（meta 查询命中同 id 缓存）。
  const lastTargetRef = useRef<PreviewTarget | null>(null);
  if (target) lastTargetRef.current = target;
  const shown = target ?? lastTargetRef.current;
  if (!shown) return null;
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      size="review"
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{shown.name}</span>
          <span className="shrink-0 text-aux font-normal text-text-tertiary">
            {labelOf(ARTIFACT_TYPE_LABEL, shown.type)}
            {shown.size_bytes !== null ? ` · ${formatBytes(shown.size_bytes)}` : ''}
          </span>
        </span>
      }
      footer={
        // link 没有磁盘文件，`/raw` 会 404（服务端：「link 类型产物没有本地文件，请直接打开 uri」），
        // 给了就是一个只会报错的死按钮；4.5 明确不要这种按钮。
        // 判 `target.type` 就够：服务端 `previewFor` 只在 type 为 link 时才回 kind: 'link'。
        // 同理，列表行已经标了 `missing` 的丢失文件也不给下载（`/raw` 回 404 ARTIFACT_LOST）。
        shown.type === 'link' || shown.missing ? null : (
          <Button
            size="sm"
            icon={<Download className="size-3.5" />}
            onClick={() => void downloadArtifact(shown.id, shown.name).catch(() => undefined)}
          >
            下载
          </Button>
        )
      }
    >
      <PreviewBody target={shown} maxMb={maxMb} />
    </Dialog>
  );
}

function PreviewBody({ target, maxMb }: { target: PreviewTarget; maxMb: number }) {
  const meta = useArtifactMeta(target.id);
  const decision = meta.data?.preview;

  // 行数据已经标了丢失就直接落灰态（验收 42 的同一条口径），不等 meta 回来；
  // 后两条仍是兜底——从别的入口进来时只有服务端判定知道文件没了。
  if (target.missing || meta.data?.missing || decision?.reason === 'file_missing') {
    return (
      <EmptyState
        className="border-border bg-bg-muted"
        title="产物文件已丢失"
        description={COPY.artifactLost}
      />
    );
  }

  if (decision?.reason === 'too_large') {
    return (
      <EmptyState
        title={previewTooLargeText(maxMb)}
        description={TOO_LARGE_HINT}
      />
    );
  }

  const kind = decision?.kind ?? kindFromType(target.type);

  if (kind === 'diff') return <DiffViewer artifactId={target.id} />;
  if (kind === 'image') return <ImageViewer artifactId={target.id} name={target.name} />;
  if (kind === 'link') {
    if (meta.isPending) return <Skeleton className="h-28 w-full rounded-card" />;
    if (meta.isError) {
      return <EmptyState title="外链信息读取失败" description={errorMessage(meta.error)} />;
    }
    // `uri` 是 Agent 在 `complete_task` 里自报的（12 章），服务端 20.6 只校格式、不担保内容，
    // 所以目标地址摊开给用户自己看过再决定点不点。
    const uri = (meta.data?.uri ?? '').trim();
    // `desktop.openExternal` 对非 http(s) 是**静默 return**，按钮点了不会有任何反应；
    // 与其留个假按钮，不如把话说清楚（6.10.1：link 只接受 http(s)）。
    const openable = /^https?:\/\//i.test(uri);
    return (
      <div className="flex flex-col gap-2">
        <EmptyState
          title={openable ? '外链没有可预览的内容' : '这条外链不是 http(s) 地址'}
          description={
            openable
              ? '6.10.1：link 类型交系统默认浏览器打开，本窗口不会导航过去。'
              : '非 http(s) 的 uri 不予打开（15 章：不给 WebView 留导航出口）。'
          }
          action={
            openable ? (
              <Button
                size="sm"
                icon={<ExternalLink className="size-3.5" />}
                onClick={() => void desktop.openExternal(uri).catch(() => undefined)}
              >
                浏览器打开
              </Button>
            ) : undefined
          }
        />
        <p className="text-aux text-text-tertiary">目标地址（Agent 上报，未经校验）</p>
        <p className="select-all break-all rounded-control border border-border bg-bg-muted px-3 py-2 font-mono text-code text-text-primary">
          {uri === '' ? '（这条产物没有 uri）' : uri}
        </p>
      </div>
    );
  }
  return <TextBody artifactId={target.id} />;
}

/** meta 还没回来时按 6.10.1 的类型表先选渲染器，避免打开瞬间闪一下空态。 */
function kindFromType(type: string): 'diff' | 'text' | 'image' | 'link' {
  if (type === 'diff') return 'diff';
  if (type === 'image') return 'image';
  if (type === 'link') return 'link';
  return 'text';
}

function TextBody({ artifactId }: { artifactId: string }) {
  const { text, loading, error, reload } = useArtifactText(artifactId);

  if (loading) {
    return <p className="py-6 text-center text-aux text-text-tertiary">正文加载中…</p>;
  }
  if (error) {
    const lost = error === COPY.artifactLost;
    return (
      <EmptyState
        title={lost ? '产物文件已丢失' : '正文读取失败'}
        description={error}
        action={
          lost ? undefined : (
            <Button size="sm" onClick={reload}>
              重试
            </Button>
          )
        }
      />
    );
  }
  if (text === null) return null;
  return <TextViewer text={text} />;
}
