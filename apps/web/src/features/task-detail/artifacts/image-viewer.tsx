import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, RefreshCw } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { COPY } from '@/lib/copy';
import { useSignedUrl } from './use-artifact-content';

/**
 * 原型 9.2 图片预览：内嵌显示 + 缩放（−/百分比/+/适应窗口/原始大小）。
 *
 * `src` 必须是**现签**的一次性 URL（13 章）：签名 60 秒过期、nonce 用一次即废，
 * 所以这里既不进 react-query、也不能把 URL 存进可被复用的缓存；
 * `<img>` 加载失败时自动再签一条（最多一次，避免 401 循环刷签名）。
 */

const FIT_SCALE = 1;
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

export function ImageViewer({ artifactId, name }: { artifactId: string; name: string }) {
  const { url, loading, error, reload } = useSignedUrl(artifactId);
  const [scale, setScale] = useState(FIT_SCALE);
  const [actual, setActual] = useState(false);
  const retried = useRef(false);

  useEffect(() => {
    retried.current = false;
    setScale(FIT_SCALE);
    setActual(false);
  }, [artifactId]);

  const onError = useCallback(() => {
    if (retried.current) return;
    retried.current = true;
    reload();
  }, [reload]);

  if (loading) {
    return <div className="flex h-[40vh] items-center justify-center text-aux text-text-tertiary">图片加载中…</div>;
  }
  if (error || !url) {
    return (
      <EmptyState
        title={error === COPY.artifactLost ? '产物文件已丢失' : '图片无法显示'}
        description={error ?? COPY.artifactLost}
        action={
          <Button size="sm" icon={<RefreshCw className="size-3.5" />} onClick={reload}>
            重新加载
          </Button>
        }
      />
    );
  }

  const percent = Math.round(scale * 100);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="atb-scroll flex max-h-[52vh] min-h-[200px] items-start justify-center overflow-auto rounded-card border border-border bg-bg-muted p-2">
        <img
          src={url}
          alt={name}
          onError={onError}
          style={
            actual
              ? { maxWidth: 'none', transform: `scale(${scale})`, transformOrigin: 'top left' }
              : { maxWidth: '100%', transform: `scale(${scale})`, transformOrigin: 'top center' }
          }
          className="rounded-tag bg-bg-surface object-contain shadow-card"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => setScale((value) => Math.max(MIN_SCALE, Number((value - 0.25).toFixed(2))))}
        >
          −
        </Button>
        <span className="w-12 text-center font-mono text-aux text-text-secondary">{percent}%</span>
        <Button
          size="sm"
          onClick={() => setScale((value) => Math.min(MAX_SCALE, Number((value + 0.25).toFixed(2))))}
        >
          +
        </Button>
        <Button
          size="sm"
          variant={actual ? 'default' : 'subtle'}
          icon={<Maximize className="size-3.5" />}
          onClick={() => {
            setActual(true);
            setScale(1);
          }}
        >
          原始大小
        </Button>
        <Button
          size="sm"
          variant={actual ? 'subtle' : 'default'}
          onClick={() => {
            setActual(false);
            setScale(FIT_SCALE);
          }}
        >
          适应窗口
        </Button>
      </div>
    </div>
  );
}
