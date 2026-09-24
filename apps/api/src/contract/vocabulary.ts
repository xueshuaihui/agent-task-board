/**
 * B6 MCP 词表规范化：所有「词表类」字段描述与 `get_vocabulary` 工具载荷的单一来源。
 *
 * WHY：MCP 工具 schema 会经 `tools/list` 下发给客户端，agent 读得到字段描述；
 * 之前描述缺可接受值，agent 只能试错猜词表，制造大量测试数据。这里把
 * 词表值全部从 enums / skills.dto / transitions 现有常量派生（不手抄第二套字符串），
 * schema 侧 `.describe()` 与 get_vocabulary 返回体共用同一批常量，避免两处漂移。
 */
import {
  AGENT_CONFIRMATION_MODES,
  ARTIFACT_TYPES,
  BREAKDOWN_SESSION_STATUSES,
  BREAKDOWN_STATUS_LABEL,
  CAPABILITY_NAMESPACES,
  DEFAULT_TASK_TYPES,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASK_STATUS,
} from './enums';
import { CAPABILITY_RE } from './schemas';
import { classifyTransition } from './transitions';
import { SKILL_ORIGINS, SKILL_STATUSES, SKILL_TYPES } from '../skills/skills.dto';
import {
  SKILL_CATEGORIES,
  SKILL_CATEGORY_TREE,
  UNCATEGORIZED,
} from '../skills/skill-categories';

/** 优先级各级文案：0=紧急 / 1=高 / 2=中 / 3=低（20.2，从 PRIORITY_LABEL 派生）。 */
export const PRIORITY_LEVELS_TEXT = PRIORITIES.map((value) => `${value}=${PRIORITY_LABEL[value]}`).join(
  '，',
);

/** 创建/草案的 priority 字段描述（缺省 3=低）。 */
export const PRIORITY_FIELD_DESC = `优先级，整数：${PRIORITY_LEVELS_TEXT}；数字越小越紧急，缺省 3（低）。表外值 422。`;

/** capabilities 数组字段（claim / list_ready_tasks / token）通用描述。 */
export const CAPABILITIES_ARRAY_DESC =
  `能力标识数组，单条格式 namespace:value（正则 ${CAPABILITY_RE.source}，全长 ≤64；约定命名空间：${[...CAPABILITY_NAMESPACES].join('/')}，如 language:java）。` +
  `空数组=沿用 Token 签发时声明的能力集合。可见性判定：任务 required_capabilities ⊆ 生效能力集合才可领。`;

/** 任务类型过滤数组（claim / list_ready_tasks 的 task_types）描述。 */
export const TASK_TYPE_FILTER_DESC =
  `按任务类型过滤，元素须与服务端词表内类型全等（区分大小写、不做模糊匹配）。` +
  `默认词表：${DEFAULT_TASK_TYPES.join('/')}，实际生效词表以设置项 task_types 为准（可用 get_vocabulary 一次拿全）；空数组=不限类型。`;

/** board.create_task(-batch) 的 type 字段描述。 */
export const CREATE_TASK_TYPE_DESC =
  `任务类型，必须命中服务端词表（否则 422 并在错误里回显可选值）。` +
  `默认词表：${DEFAULT_TASK_TYPES.join('/')}，自定义类型由设置项 task_types 扩充（建议先调 get_vocabulary 拿当前词表，不要试错）。` +
  `注意：「需求」不走 create_task 直建（应经 board.begin_breakdown 拆解流程，§8.8）。`;

/**
 * §9.2 技能分类的「可选：…」文案（0925 树化，两级呈现）：一级（含纯分组一级与其叶子）逐组
 * 展开，事实源只有一处（SKILL_CATEGORY_TREE）。合法取值仍是 16 个叶子 + `''`；
 * 编码开发/办公实用/研究分析是**纯分组一级**，出现在文案里只用于定位分组，本身不可提交（422）。
 */
export const SKILL_CATEGORY_LIST_TEXT = SKILL_CATEGORY_TREE.map((top) =>
  top.children.length > 0 ? `${top.value}（${top.children.join('/')}）` : top.value,
).join('｜');

/**
 * 技能分类字段描述（`update_skill` 的 category `.describe()` 与 422 回显共用）。
 *
 * WHY：REST 面 `PATCH /skills/:id` 越表时只有裸 zod 形状
 * （`details[0].message = 'Invalid option: expected one of ...'`），既没有中文的
 * 「可选：…」全量词表也没有当前值——那一条 UI 的控件回填在用，形状不许改；
 * 所以补在 agent 入口这一层（见 `mcp/agent-tools.ts` 的 `parseToolInput`）。
 */
export const SKILL_CATEGORY_DESC =
  `技能分类，单值，必须命中服务端两级树词表的 16 个叶子（否则 422 并在 details 里回显「可选：…」两级全量词表）。` +
  `可选：${SKILL_CATEGORY_LIST_TEXT}；括号内的二级才是合法取值，编码开发/办公实用/研究分析是纯分组一级、不可直接提交，另接受空串 ''（=未分类）；不传=不改分类。` +
  `分类与 tags 是两件事：tags 是自由标签、不从词表推导（六个产研阶段词双角色：既是叶子又是合法标签）。`;

/** §8.2 三种确认模式的语义表（get_vocabulary 与字段描述共用）。 */
export const CONFIRMATION_MODE_SEMANTICS: Record<(typeof AGENT_CONFIRMATION_MODES)[number], string> = {
  direct: '直接创建：立即落库并记流水，不等人工确认',
  light: '轻确认：缺省服务端阻塞等待确认决策（超时 30s + 5s 宽限，超时不创建）；wait:false 走异步，立即返回 request_id，用 board.get_creation_status 轮询',
  silent: '静默创建：立即落库，只发通知不打断，来源标记为 agent',
};

export const CONFIRMATION_MODE_DESC =
  `确认模式，三值：${AGENT_CONFIRMATION_MODES.map((mode) => `${mode}=${CONFIRMATION_MODE_SEMANTICS[mode]}`).join('；')}。` +
  `缺省按 §8.2 优先级解析：本参数 > 设置项 agent_creation_mode > light。`;

/** 产物类型描述：link 例外（uri 是 http(s) 外链），其余为上传接口返回的相对路径。 */
export const ARTIFACT_TYPE_DESC =
  `产物类型，取值：${ARTIFACT_TYPES.join('/')}。link 的 uri 必须为 http(s) 外链且 name 必填；` +
  `其余类型 uri 必须为「先经上传接口返回」的相对路径（不以 / 开头、不含 ..），Agent 侧只允许 type=log 由 append_log 产生。`;

/** 内置日志级别枚举（append_log.level / settings.log_level）。 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** get_vocabulary 直接返回的词表快照的组装入参：只有两个值来自 settings（热配置），其余全是常量。 */
export interface VocabularyInput {
  /** 设置项 task_types 当前值（默认 + 自定义后的生效词表）。 */
  taskTypes: string[];
  /** 设置项 agent_creation_mode 当前值（确认模式缺省来源）。 */
  agentCreationMode: (typeof AGENT_CONFIRMATION_MODES)[number];
}

/** 从 classifyTransition 派生「当前允许的人工/接口流转」表，不复制矩阵数据。 */
function transitionTable(): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  for (const from of TASK_STATUS) {
    const entries: string[] = [];
    for (const to of TASK_STATUS) {
      if (from === to) continue;
      const kind = classifyTransition(from, to);
      if (kind.kind === 'direct') entries.push(`${to}（直接流转）`);
      else if (kind.kind === 'form') entries.push(`${to}（需${kind.form === 'review' ? '审核表单' : '强制停止'}）`);
    }
    table[from] = entries;
  }
  return table;
}

/**
 * get_vocabulary 的返回体：服务端当前全部词表口径。
 * 值全部来自 contract 常量 / settings 现值，与校验实现同源，agent 一次调用拿全、不再试错。
 */
export function buildVocabulary(input: VocabularyInput) {
  return {
    task_types: {
      default: [...DEFAULT_TASK_TYPES],
      current: input.taskTypes,
      source: '设置项 task_types（20.9，可含自定义类型；创建/导入/字段 applies_to 均以 current 为准）',
      note: '「需求」类型不走 board.create_task 直建，需经 board.begin_breakdown 拆解流程',
    },
    priority: {
      values: [...PRIORITIES],
      labels: Object.fromEntries(PRIORITIES.map((value) => [value, PRIORITY_LABEL[value]])),
      default: 3,
      note: PRIORITY_LEVELS_TEXT + '；数字越小越紧急',
    },
    confirmation_mode: {
      values: [...AGENT_CONFIRMATION_MODES],
      semantics: { ...CONFIRMATION_MODE_SEMANTICS },
      default: input.agentCreationMode,
      precedence: '入参 confirmation_mode > 设置项 agent_creation_mode > light',
    },
    task_status: {
      values: [...TASK_STATUS],
      labels: { ...STATUS_LABEL },
      transitions: transitionTable(),
      note: 'RUNNING 只能由 claim_next_task 认领事务产生；DONE 为终态；Agent 回写路径：complete_task→REVIEW、fail_task→FAILED、block_task→BLOCKED',
    },
    capability: {
      format: 'namespace:value',
      pattern: CAPABILITY_RE.source,
      max_length: 64,
      namespaces: [...CAPABILITY_NAMESPACES],
      examples: ['language:java', 'framework:nestjs', 'repo:agent-task-board', 'tool:git'],
      matching: '约定外的命名空间不校验取值、按字符串全等匹配（无通配符）；任务 required_capabilities ⊆ Token 生效能力集合才可领',
    },
    skill: {
      types: [...SKILL_TYPES],
      statuses: [...SKILL_STATUSES],
      origins: [...SKILL_ORIGINS],
    },
    // §9.2 单值分类（0925 树化两级口径）：与 task_types 同一形状（values + source + note），
    // 词表不随设置变化。values 是 16 个**合法叶子**（可提交值）；tree 给一级→二级的分组结构，
    // 其中编码开发/办公实用/研究分析为纯分组一级、不在 values 里。
    skill_categories: {
      values: [...SKILL_CATEGORIES],
      tree: SKILL_CATEGORY_TREE.map((top) => ({ value: top.value, children: [...top.children] })),
      uncategorized: UNCATEGORIZED,
      source:
        'src/skills/skill-categories.ts（两级树词表：7 个一级 / 16 个合法叶子，与 0018 迁移的 category CHECK 逐项一致；内置 35 行叶子归位见 0019）',
      note: SKILL_CATEGORY_DESC,
    },
    artifact_types: {
      values: [...ARTIFACT_TYPES],
      uri_rule: 'link 的 uri 为 http(s) 外链；其余类型为上传接口返回的相对路径（不以 / 开头、不含 ..）',
    },
    log_level: { values: [...LOG_LEVELS], default: 'info' },
    breakdown_session_status: {
      values: [...BREAKDOWN_SESSION_STATUSES],
      labels: { ...BREAKDOWN_STATUS_LABEL },
    },
  } as const;
}
