import { z } from 'zod';
import { ARTIFACT_TYPES } from '../contract/enums';

/** 产物主键是服务端生成的 UUID v7（20.1）：id 只用来查库，不参与路径组装，但仍先卡形状。 */
export const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const artifactIdSchema = z.string().regex(ARTIFACT_ID_RE, '产物 id 需为 UUID');

/** multipart 的文本字段一律是字符串，这里不 coerce 布尔——上传接口没有布尔入参。 */
export const artifactUploadSchema = z.object({
  task_id: z.string().trim().min(1).max(64),
  run_id: z.string().trim().min(1).max(64),
  name: z.string().trim().max(200).optional(),
  mime_type: z.string().trim().max(128).optional(),
  /** 6.10.1：Agent 自报的类型只用于回显对比，落库类型按 mime + 扩展名推导。 */
  type: z.enum(ARTIFACT_TYPES).optional(),
});
export type ArtifactUploadInput = z.infer<typeof artifactUploadSchema>;

export const signQuerySchema = z.object({
  exp: z.string().regex(/^\d{1,12}$/),
  n: z.string().regex(/^[0-9a-f]{8,64}$/),
  s: z.string().regex(/^[0-9a-f]{64}$/),
});
