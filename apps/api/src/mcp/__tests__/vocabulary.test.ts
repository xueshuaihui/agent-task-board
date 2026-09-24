import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../../auth/auth.scope';
import { DEFAULT_TASK_TYPES } from '../../contract/enums';
import { createTaskSchema } from '../../contract/agent-schemas';
import { buildVocabulary } from '../../contract/vocabulary';
import { parseToolInput } from '../../mcp/agent-tools';
import { SKILL_CATEGORIES } from '../../skills/skill-categories';
import { callAgentTool } from '../../mcp/mcp.server';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';
import { ApiException } from '../../contract/errors';

/**
 * B6 MCP 词表规范化：
 *  1. `get_vocabulary` 只读工具——返回体与 contract 常量同源（task_types 恒等于
 *     DEFAULT_TASK_TYPES 起步词表；改设置后 current 跟随、default 不动）；
 *  2. `parseToolInput` 422 回显——错误里带可接受值/区间与字段 .describe() 文案，
 *     agent 不用再靠试错猜入参形状。
 */
let h: AgentHarness;
let agent: RequestAuth;
const ui: RequestAuth = { kind: 'ui' };

const toolCtx = () => ({
  claims: h.claims,
  leases: h.leases,
  writeback: h.writeback,
  query: h.query,
  skills: h.skills,
  policy: h.policy,
  breakdown: h.breakdown,
  creation: h.creation,
  settings: h.settings,
});

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('vocab-client', []);
});

afterAll(async () => {
  await h?.dispose();
});

describe('get_vocabulary：一次调用拿全服务端词表', () => {
  it('返回含 task_types，且缺省词表与 DEFAULT_TASK_TYPES 一致；其余口径成组在场', async () => {
    const result = (await callAgentTool(toolCtx(), agent, 'get_vocabulary', {})) as ReturnType<
      typeof buildVocabulary
    >;
    expect(result.task_types.default).toEqual([...DEFAULT_TASK_TYPES]);
    expect(result.task_types.current).toEqual([...DEFAULT_TASK_TYPES]);
    // 优先级 0-3 与各级含义、确认模式三值、状态机七态与流转表、能力命名空间、技能类型。
    expect(result.priority.values).toEqual([0, 1, 2, 3]);
    expect(result.priority.labels).toMatchObject({ 0: '紧急', 3: '低' });
    expect(result.confirmation_mode.values).toEqual(['direct', 'light', 'silent']);
    expect(result.task_status.values).toContain('BLOCKED');
    expect(result.task_status.transitions.READY.join(' ')).toContain('BACKLOG');
    expect(result.capability.namespaces).toContain('language');
    expect(result.capability.format).toBe('namespace:value');
    expect(result.capability.pattern).toBe('^[a-z][a-z0-9_-]*:[^\\s]+$');
    expect(result.skill.types).toContain('workflow');
    // §16.1 `update_skill` 的 category 词表也在场：agent 一次调用拿到「可写面 + 可接受值」全口径。
    // 0925 树化：values 是 16 个**合法叶子**（可提交值），tree 是两级结构（7 个一级，其中
    // 编码开发/办公实用/研究分析为纯分组一级、不在 values 里）；source 文案钉 0018 CHECK。
    expect(result.skill_categories.values).toEqual([...SKILL_CATEGORIES]);
    expect(result.skill_categories.values).toHaveLength(16);
    expect(result.skill_categories.values).not.toContain('质量保障');
    expect(result.skill_categories.values).not.toContain('编码开发');
    expect(result.skill_categories.tree.map((top) => top.value)).toEqual([
      '编码开发',
      '教育学习',
      '内容创作',
      '方案写作',
      '投资理财',
      '办公实用',
      '研究分析',
    ]);
    expect(result.skill_categories.tree.find((top) => top.value === '编码开发')!.children).toEqual([
      '需求与规划',
      '开发与实现',
      '质量与安全',
      '代码清理',
      '运维与协作',
      '测试自动化',
      '开发编程',
    ]);
    expect(result.skill_categories.tree.find((top) => top.value === '教育学习')!.children).toEqual([]);
    expect(result.skill_categories.source).toContain('0018');
    expect(result.skill_categories.uncategorized).toBe('');
    expect(result.skill_categories.note).toContain('可选：');
  });

  it('词表与服务端设置同源：改 task_types 后 current 跟随、default 仍是预置五类', async () => {
    await h.settings.patch({ task_types: ['需求', '缺陷', '巡检'] });
    const result = (await callAgentTool(toolCtx(), agent, 'get_vocabulary', {})) as ReturnType<
      typeof buildVocabulary
    >;
    expect(result.task_types.current).toEqual(['需求', '缺陷', '巡检']);
    expect(result.task_types.default).toEqual([...DEFAULT_TASK_TYPES]);
    await h.settings.patch({ task_types: [...DEFAULT_TASK_TYPES] });
  });

  it('只读工具的鉴权口径与 list_skills 一致：Agent 凭证可用、UI 会话 Token 拒绝', async () => {
    await expect(callAgentTool(toolCtx(), ui, 'get_vocabulary', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('parseToolInput：422 回显可接受值与字段描述', () => {
  it('枚举值非法时错误带「可接受值」全部取值与 confirmation_mode 的 describe 文案', () => {
    let caught: ApiException | undefined;
    try {
      parseToolInput(createTaskSchema, {
        title: 'x',
        type: '缺陷',
        session_id: 's-1',
        confirmation_mode: 'whisper',
      });
    } catch (error) {
      caught = error as ApiException;
    }
    expect(caught?.code).toBe('VALIDATION_FAILED');
    const text = JSON.stringify(caught?.toBody());
    // issue 自带全部可接受值（不再是裸 schema 报错）。
    expect(text).toContain('"invalid_value"');
    expect(text).toContain('direct');
    expect(text).toContain('silent');
    // 字段 .describe() 的中文语义也随错误下发。
    expect(text).toContain('确认模式，三值');
    // 顶层 message 同样内联提示，客户端只看 message 也能收敛。
    expect(caught?.message).toContain('confirmation_mode');
  });

  it('区间/缺字段类错误回显边界与三元组描述', () => {
    let caught: ApiException | undefined;
    try {
      parseToolInput(createTaskSchema, {
        title: 'x',
        type: '缺陷',
        session_id: 's-1',
        priority: 9,
      });
    } catch (error) {
      caught = error as ApiException;
    }
    const text = JSON.stringify(caught?.toBody());
    expect(text).toContain('至多 3');
    expect(text).toContain('优先级，整数');
    expect(text).toContain('数字越小越紧急');
  });
});
