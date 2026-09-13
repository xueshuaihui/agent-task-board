import { apiUrl } from '../env';
import { http } from '../client';
import type { ArtifactDiff, ArtifactMeta, SignedArtifactUrl } from '../types';

/**
 * 13 章产物接口。`/raw` 与 `/thumbnail` 由 `<img>`、iframe、pdf.js 直接加载，
 * 带不了自定义头，所以**必须先换 60 秒一次性签名 URL 再加载**——
 * 把 UI Token 拼进查询参数会落进访问日志，是这条契约存在的唯一理由（20.6 同源）。
 */
export const artifactsApi = {
  /** 元信息：`missing: true` 时渲染「产物文件已丢失（不在备份范围内）」。 */
  meta: (id: string) => http.get<ArtifactMeta>(`/artifacts/${enc(id)}`),
  /**
   * 一次性签名 URL。raw 与 thumbnail 是**两条不同的签发端点**（服务端 13 章表里只有
   * `/sign`，缩略图是它多出来的一条 `POST /sign-thumbnail`），签名互不通用，所以按 variant 分流。
   */
  sign: (id: string, variant: 'raw' | 'thumbnail' = 'raw') =>
    http.post<SignedArtifactUrl>(
      `/artifacts/${enc(id)}${variant === 'thumbnail' ? '/sign-thumbnail' : '/sign'}`,
    ),
  /** diff 解析结果，前端不自己切 hunk。 */
  diff: (id: string) => http.get<ArtifactDiff>(`/artifacts/${enc(id)}/diff`),
};

/**
 * 换一条可直接塞进 `src` 的绝对地址。
 * 60 秒后签名失效：图片懒加载/抽屉长时间停留后要重新签，不要把返回值缓存在组件 state 里。
 */
export async function artifactSrc(id: string, variant: 'raw' | 'thumbnail' = 'raw'): Promise<string> {
  const signed = await artifactsApi.sign(id, variant);
  return apiUrl(signed.url);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
