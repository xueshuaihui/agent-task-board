import type { ArtifactMeta, AuditEntry } from '@/api';

/**
 * 抽屉内部使用的「读取视图」类型。
 *
 * 为什么要这一层：服务端 `GET /artifacts/:id` 实际还带 `preview` 与 `signed_url`
 * （13 章产物接口 + 6.10.1 的阶段判定），而基座 `ArtifactMeta`（`@/api/types`）没有声明它们；
 * `/artifacts/:id/diff` 同理只声明了 `files[].hunks: unknown[]`。
 * `src/api/**` 由其他 agent 持有，所以只在 feature 内补形状、不改基座。
 */

export type PreviewKind = 'diff' | 'text' | 'image' | 'link' | 'none';

/** 服务端按 6.10.1 + 6.10.3 算好的「能不能预览、为什么不能」。 */
export interface ArtifactPreviewDecision {
  enabled: boolean;
  kind: PreviewKind;
  /** `file_missing` / `too_large` / `renderer_not_in_stage1`。 */
  reason: string | null;
}

export interface ArtifactMetaView extends ArtifactMeta {
  preview?: ArtifactPreviewDecision | null;
  /** 一次性签名 URL（60 秒、nonce 用一次即废），**不要缓存复用**。 */
  signed_url?: string | null;
}

export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLineView {
  type: DiffLineKind;
  old_line: number | null;
  new_line: number | null;
  text: string;
}

export interface DiffHunkView {
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLineView[];
}

export interface DiffFileView {
  path: string;
  old_path: string | null;
  status?: string;
  binary?: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunkView[];
}

export interface DiffResultView {
  files: DiffFileView[];
  additions?: number;
  deletions?: number;
  /** 认不出来的行：不静默丢弃（原型 9.1）。 */
  unparsed_lines?: number;
  /** 6.10.3：超过上限时服务端只解析前 N 字节。 */
  truncated?: boolean;
  name?: string;
}

/** 抽屉里要往上抛的产物预览目标。 */
export interface PreviewTarget {
  id: string;
  name: string;
  type: string;
  size_bytes: number | null;
  /**
   * 列表行已经读到的 `missing`（6.10.2 / 验收 42）：带上后预览框不必等
   * `GET /artifacts/:id` 就落灰态，footer 的下载也不再给。缺省时按元信息接口判定。
   */
  missing?: boolean;
}

/**
 * 4.10 审计行。服务端 `AuditItemDto` 比基座的 `AuditEntry` 多带 `actor_label`
 * （20.8 的展示口径由服务端一次定死：`user` → 我、`system` → 系统），
 * 基座类型没声明，这里在 feature 内补上；缺失时前端退回本地映射。
 */
export interface AuditEntryView extends AuditEntry {
  actor_label?: string | null;
  /** 审计分页 `page_size` 固定 50，服务端顺手给了总页数。 */
  total_pages?: number;
}
