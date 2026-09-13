import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  ERROR_CODE_COPY,
  api,
  artifactSrc,
  errorMessage,
  isKnownErrorCode,
} from '@/api';
import type { ApiErrorBody } from '@/api';
import { desktop } from '@/app/desktop';
import { COPY } from '@/lib/copy';
import { hasPreviewer } from '../phase';
import type { ArtifactMetaView, ArtifactPreviewDecision, PreviewKind } from '../types';

/**
 * 产物内容的读取（6.10.1、13 章「资源型端点例外」）。
 *
 * 关键约束：`POST /artifacts/:id/sign` 换到的是 **60 秒 + 一次性** 的 URL
 * （`apps/api/src/artifacts/artifact-sign.service.ts` 里 nonce 用过即废）。
 * 所以这三件事都不进 react-query：缓存一条签名 URL = 第二次加载必然 401。
 * 每次要显示/下载都重新签一条，`reload()` 就是「再签一次」。
 */

export interface ArtifactActionInfo {
  /** `none` 只用于「产物文件已丢失」的灰态（13 章）。 */
  action: 'preview' | 'download' | 'open-link' | 'none';
  kind: PreviewKind | null;
  /** 行尾的灰色说明（例如阶段二渲染器、超过上限、已丢失）。 */
  note: string | null;
}

/**
 * `resolveAction` 只读这两项，所以两个来源都能传：
 * - `GET /artifacts/:id` 的元信息视图（`ArtifactMetaView` 结构上就是它的超集）；
 * - `runs[].artifacts[]` 的行数据（只有 `missing`，没有 `preview`，13 章 / 验收 42）。
 *
 * 缺 `preview` 时下面的判定自动退回「按类型 + 体积」那条本地口径，与改动前行为一致。
 */
export interface ArtifactActionInput {
  missing?: boolean;
  preview?: ArtifactPreviewDecision | null;
}

/** 6.10.1 阶段一动作表：`link` 交系统浏览器，阶段二的四类与 `file` 只给下载。 */
export function resolveAction(
  type: string,
  sizeBytes: number | null | undefined,
  maxMb: number,
  meta?: ArtifactActionInput | null,
): ArtifactActionInfo {
  if (meta?.missing) {
    return { action: 'none', kind: null, note: COPY.artifactLost };
  }
  // 服务端的 preview 判定是真相（类型推导 + mime + 上限都在那儿算）。
  const decision = meta?.preview;
  if (decision && decision.kind !== 'none') {
    return { action: decision.kind === 'link' ? 'open-link' : 'preview', kind: decision.kind, note: null };
  }
  if (type === 'link') return { action: 'open-link', kind: 'link', note: null };
  if (!hasPreviewer(type)) {
    return {
      action: 'download',
      kind: null,
      note: ['markdown', 'json', 'html', 'pdf'].includes(type)
        ? '阶段二提供预览'
        : '无预览器',
    };
  }
  const maxBytes = maxMb * 1024 * 1024;
  if (sizeBytes !== null && sizeBytes !== undefined && sizeBytes > maxBytes) {
    return { action: 'download', kind: null, note: `超过 ${maxMb} MB，只下载` };
  }
  const kind: PreviewKind = type === 'diff' ? 'diff' : type === 'image' ? 'image' : 'text';
  return { action: 'preview', kind, note: null };
}

/** 一次性 URL 的读取失败也要出「按码分支」的文案，所以包装成 ApiError。 */
async function toApiError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const code = body?.error?.code;
  const known = typeof code === 'string' && isKnownErrorCode(code) ? code : 'UNKNOWN';
  return new ApiError({
    code: known,
    message: body?.error?.message ?? `HTTP ${response.status}`,
    status: response.status,
  });
}

/** 文本/日志正文（`<pre>` 用）。图片走 `<img src>`，不需要把字节读进 JS。 */
export async function fetchArtifactText(id: string): Promise<string> {
  const url = await artifactSrc(id, 'raw');
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw await toApiError(response);
  return response.text();
}

/**
 * 下载：签一条 URL，用 `<a download>` 触发。
 * 服务端已经带 `Content-Disposition: attachment`（15 章硬约束 3），这里只是不让签名 URL 出现在界面上。
 */
export async function downloadArtifact(id: string, name: string): Promise<void> {
  const url = await artifactSrc(id, 'raw');
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * 6.10.1 末段：`link` 只接受 `http(s)`，点击交系统默认浏览器，不由 WebView 导航。
 * 必须走 `desktop.openExternal`：主进程不在时它自己退回 `window.open`，但生产态反过来不行——
 * WebView 直接 `window.open` 在只有 `core:default` 能力的壳里会被 Tauri 拒掉，按钮点了没反应。
 */
export async function openExternalArtifact(id: string): Promise<void> {
  const meta = (await api.artifacts.meta(id)) as ArtifactMetaView;
  const uri = meta.uri ?? '';
  if (!/^https?:\/\//i.test(uri)) {
    throw new ApiError({ code: 'INVALID_PARAM', message: '该产物不是 http(s) 外链，无法打开' });
  }
  await desktop.openExternal(uri);
}

export interface RawContentState {
  text: string | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useArtifactText(artifactId: string | null): RawContentState {
  const [state, setState] = useState<{ text: string | null; loading: boolean; error: string | null }>(
    { text: null, loading: false, error: null },
  );

  const load = useCallback(async () => {
    if (!artifactId) {
      setState({ text: null, loading: false, error: null });
      return;
    }
    setState({ text: null, loading: true, error: null });
    try {
      setState({ text: await fetchArtifactText(artifactId), loading: false, error: null });
    } catch (error) {
      setState({ text: null, loading: false, error: errorMessage(error) });
    }
  }, [artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: () => void load() };
}

export interface SignedUrlState {
  url: string | null;
  loading: boolean;
  error: string | null;
  /** 再签一条：图片加载失败（签名过期/被消费）时由 `onError` 调。 */
  reload: () => void;
}

export function useSignedUrl(artifactId: string | null): SignedUrlState {
  const [state, setState] = useState<{ url: string | null; loading: boolean; error: string | null }>(
    { url: null, loading: false, error: null },
  );

  const load = useCallback(async () => {
    if (!artifactId) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    setState({ url: null, loading: true, error: null });
    try {
      setState({ url: await artifactSrc(artifactId, 'raw'), loading: false, error: null });
    } catch (error) {
      const text = errorMessage(error);
      setState({
        url: null,
        loading: false,
        // 404 ARTIFACT_LOST 的兜底文案换成灰态口径（13 章）。
        error: text === ERROR_CODE_COPY.ARTIFACT_LOST ? COPY.artifactLost : text,
      });
    }
  }, [artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, reload: () => void load() };
}
