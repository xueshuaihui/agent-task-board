import { useState } from 'react';
import {
  Braces,
  File,
  FileCode2,
  FileText,
  FileX2,
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
import { ARTIFACT_LOST_SHORT } from '../labels';
import { downloadArtifact, openExternalArtifact, resolveAction } from './use-artifact-content';

/**
 * 原型 4.5 的产物行 + 9 章预览器的入口。
 *
 * 四件事按文档钉死：
 * - 一行**只有一个**动作按钮，且不给置灰按钮（4.5「置灰的下载/预览按钮会让人以为是网络问题」）；
 * - 阶段二的四类（markdown/json/html/pdf）不给预览入口，只给下载，图标仍按类型区分（6.10.1）；
 * - 显示的是 `artifacts[].name`（服务端从 `metadata.name` 或 uri 末段推导，20.7），
 *   磁盘上的 `{artifact_id}.{ext}` 不出现在界面上；
 * - **验收 42**：`missing`（6.10.2 / 9.3）在这一层就标出来，不等点开预览框。
 *
 * 行数据（`runs[].artifacts[]`）带 `missing`、但**不带 `uri`**（20.6：uri 只在元信息接口里给），
 * 所以这里仍不预取 `/artifacts/:id`：动作按「类型 + `missing` + size_bytes vs artifact_max_mb」
 * 决定，正文能不能真读出来还是由预览框按服务端判定收口。
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
  // 第 4 个参数就是这一行自己：`missing` 要传进去，否则行内永远算不出灰态（验收 42）。
  const decision = resolveAction(artifact.type, artifact.size_bytes, maxMb, artifact);
  /** 6.10.2：与 `resolveAction` 读的是同一个字段，所以灰态必然没有动作按钮。 */
  const lost = artifact.missing === true;

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    void fn()
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setBusy(false));
  };

  const typeLabel = labelOf(ARTIFACT_TYPE_LABEL, artifact.type);
  const openPreview = () =>
    onPreview({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      // 丢失的文件不报体积：`size_bytes` 是入库那一刻的旧值，摆在灰态框头上就是误导。
      size_bytes: lost ? null : artifact.size_bytes,
      missing: lost,
    });

  const nameClass = 'min-w-0 flex-1 truncate text-left text-card-title';

  return (
    <li
      className={cn(
        'flex items-center gap-2 px-3 py-2',
        active && 'bg-primary-light',
        lost && 'bg-bg-muted',
      )}
    >
      {lost ? (
        <FileX2 className="size-4 shrink-0 text-status-blocked" aria-hidden />
      ) : (
        <ArtifactIcon type={artifact.type} />
      )}
      {lost ? (
        // 灰态行仍然给开框的口：4.5 说的是不给**死按钮**，预览框里那句丢失说明得有地方看。
        <button
          type="button"
          onClick={openPreview}
          className={cn(nameClass, 'text-text-secondary underline-offset-2 hover:text-text-primary hover:underline')}
          title={`${typeLabel}：${artifact.name} — ${ARTIFACT_LOST_SHORT}`}
        >
          {artifact.name}
        </button>
      ) : (
        <span className={cn(nameClass, 'text-text-primary')} title={`${typeLabel}：${artifact.name}`}>
          {artifact.name}
        </span>
      )}
      <span
        className={cn(
          'shrink-0 text-aux',
          lost ? 'text-status-blocked' : 'text-text-tertiary',
        )}
      >
        {lost
          ? ARTIFACT_LOST_SHORT
          : decision.note ?? (artifact.size_bytes !== null ? formatBytes(artifact.size_bytes) : typeLabel)}
      </span>
      {/* `missing` 行的 `decision.action` 是 `none`：预览/下载/浏览器打开三个按钮一个都不给。
          下载更不能再给——服务端 `/raw` 此时回 404 `ARTIFACT_LOST`，点了只会报错（6.10.2）。 */}
      {decision.action === 'preview' ? (
        <Button size="sm" onClick={openPreview}>
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
