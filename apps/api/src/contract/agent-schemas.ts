import { z } from 'zod';
import { ARTIFACT_TYPES } from './enums';
import { capabilitySchema, idLike } from './schemas';

const idParam = idLike;

/** 12 章通用契约：除三个只读工具外，写回入参必须带 task_id + run_id + lease_id 三元组。 */
export const leaseTripleSchema = z.object({
  task_id: idParam,
  run_id: idParam,
  lease_id: z.string().uuid(),
});

export const claimSchema = z.object({
  capabilities: z.array(capabilitySchema).max(20).default([]),
  task_types: z.array(z.string().trim().min(1).max(16)).default([]),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export const progressSchema = leaseTripleSchema.extend({
  progress: z.number().int().min(0).max(100),
  message: z.string().trim().max(500).optional(),
});

export const appendLogSchema = leaseTripleSchema.extend({
  /** 单次调用的行数；单 Run 累计上限 5000 行（20.8），超限由服务端做首尾保留截断。 */
  lines: z.array(z.string().max(4000)).min(1).max(500),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** 20.6：普通产物引用的是先上传后返回的相对路径；`link` 例外，uri 就是 http(s) 外链。 */
const uploadedArtifactSchema = z.object({
  type: z.enum(ARTIFACT_TYPES).exclude(['link']),
  uri: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
      'uri 需为上传接口返回的相对路径',
    ),
  size_bytes: z.number().int().min(0).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  mime_type: z.string().max(128).optional(),
});

const linkArtifactSchema = z.object({
  type: z.literal('link'),
  uri: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), '需为 http(s) 外链'),
  name: z.string().trim().min(1).max(200),
});

export const completeSchema = leaseTripleSchema.extend({
  summary: z.string().trim().max(20000).optional(),
  output: z.string().max(65536).optional(),
  artifacts: z
    .array(z.union([uploadedArtifactSchema, linkArtifactSchema]))
    .max(100)
    .default([]),
});
export type CompleteInput = z.infer<typeof completeSchema>;

export const failSchema = leaseTripleSchema.extend({
  error: z.string().trim().min(1).max(20000),
  summary: z.string().max(20000).optional(),
});

export const heartbeatSchema = leaseTripleSchema;

/** 8.4 人工块：Agent 执行到人工块时上报，任务转 BLOCKED 等人工处理。 */
export const blockedSchema = leaseTripleSchema.extend({
  block_id: z.string().trim().min(1).max(64),
  block_title: z.string().max(200).default(''),
  instruction: z.string().trim().min(1).max(2000),
});

/**
 * v0.0.4 W6 §16.1 `wait_for_resume`：长轮询等待 BLOCKED 解除。
 * 不需要三元组：`block_task` 已把租约清空，等待侧只是只读的事件订阅。
 * 超时上限 300 秒（5 分钟）是本地信任模型下 HTTP 长连接与 Agent 端友好度的折中；
 * 更长的等待由 Agent 端循环调用实现。缺省 60 秒覆盖绝大多数「人工点一下」场景。
 */
export const waitForResumeSchema = z.object({
  task_id: idParam,
  timeout_seconds: z.coerce.number().int().min(1).max(300).default(60),
});
export type WaitResumeInput = z.infer<typeof waitForResumeSchema>;

export const reviewFeedbackQuerySchema = z.object({
  task_id: idParam,
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

export const listReadyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  capabilities: z.array(capabilitySchema).max(20).default([]),
  task_types: z.array(z.string().trim().min(1).max(16)).default([]),
});
