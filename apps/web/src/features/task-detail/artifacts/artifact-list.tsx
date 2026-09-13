import { useState } from 'react';
import {
  Braces,
  File,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Link2,
  ScrollText,
} from 'lucide-react';
import { Button, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import type { RunArtifact } from '@/api';
import { cn } from '@/lib/cn';
import { ARTIFACT_TYPE_LABEL, labelOf } from '@/lib/labels';
import { formatBytes } from '@/lib/time';
import type { PreviewTarget } from '../types';
import { downloadArtifact, openExternalArtifact, resolveAction } from './use-artifact-content';

/**
 * 原型 4.5 的产物行 + 9 章预览器的入口。
 *
 * 三件事按文档钉死：
 * - 一行**只有一个**动作按钮，且不给置灰按钮（4.5「置灰的下载/预览按钮会让人以为是网络问题」）；
 * - 阶段二的四类（markdown/json/html/pdf）不给预览入口，只给下载，图标仍按类型区分（6.10.1）；
 * - 显示的是 `artifacts[].name`（服务端从 `metadata.name` 或 uri 末段推导，20.7），
 *   磁盘上的 `{artifact_id}.{ext}` 不出现在界面上。
 *
 * 行数据（`runs[].artifacts[]`）不带 `uri` 也不带 `missing`，所以这里**不预取** `/artifacts/:id`：
 * 动作按「类型 + size_bytes vs artifact_max_mb」决定，真正的丢失/超大判定在预览框里做。
 */

const TYPE_ICONS: Record<string, typeof File> = {
  diff: FileCode2,
  image: ImageIcon,
  text: FileText,
  log: ScrollText,
  markdown: FileText,
  json: Braces,
  html: FileCode2,
  pdf: FileText,
  link: Link2,
  file: File,
};

function ArtifactIcon({ type, className }: { type: string; className?: string }) {
  const Icon = TYPE_ICONS[type] ?? File;
  return <Icon className={cn('size-4 shrink-0 text-text-tertiary', className)} aria-hidden />;
}

export interface ArtifactListProps {
  artifacts: RunArtifact[];
  /** 20.9 `artifact_max_mb`：6.10.3 的「超过上限只下载」。 */
  maxMb: number;
  onPreview: (target: PreviewTarget) => void;
  /** 预览框正开着的那一行给一层落点底色。 */
  activeId?: string | null;
}

export function ArtifactList({ artifacts, maxMb, onPreview, activeId }: ArtifactListProps) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-bg-surface">
      {artifacts.map((artifact) => (
        <ArtifactRow
          key={artifact.id}
          artifact={artifact}
          maxMb={maxMb}
          onPreview={onPreview}
          active={activeId === artifact.id}
        />
      ))}
    </ul>
  );
}

interface ArtifactRowProps {
  artifact: RunArtifact;
  maxMb: number;
  onPreview: (target: PreviewTarget) => void;
  active: boolean;
}

function ArtifactRow({ artifact, maxMb, onPreview, active }: ArtifactRowProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const decision = resolveAction(artifact.type, artifact.size_bytes, maxMb);

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn()
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  const typeLabel = labelOf(ARTIFACT_TYPE_LABEL, artifact.type);

  return (
    <li
      className={cn(
        'flex items-center gap-2 px-3 py-2',
        active && 'bg-primary-light',
        decision.action === 'none' && 'bg-bg-muted',
      )}
    >
      <ArtifactIcon type={artifact.type} />
      <span
        className="min-w-0 flex-1 truncate text-card-title text-text-primary"
        title={`${typeLabel}：${artifact.name}`}
      >
        {artifact.name}
      </span>
      <span className="shrink-0 text-aux text-text-tertiary">
        {decision.note ?? (artifact.size_bytes !== null ? formatBytes(artifact.size_bytes) : typeLabel)}
      </span>
      {decision.action === 'preview' ? (
        <Button
          size="sm"
          onClick={() =>
            onPreview({
              id: artifact.id,
              name: artifact.name,
              type: artifact.type,
              size_bytes: artifact.size_bytes,
            })
          }
        >
          预览
        </Button>
      ) : null}
      {decision.action === 'download' ? (
        <Button size="sm" loading={busy} onClick={() => run(() => downloadArtifact(artifact.id, artifact.name))}>
          下载
        </Button>
      ) : null}
      {decision.action === 'open-link' ? (
        <Button size="sm" loading={busy} onClick={() => run(() => openExternalArtifact(artifact.id))}>
          浏览器打开
        </Button>
      ) : null}
    </li>
  );
}
