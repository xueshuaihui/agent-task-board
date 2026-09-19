import type { SkillContent, SkillMcpDependency } from '../skills/skills.dto';

/**
 * 内置技能种子（8.8 技能源「内置技能：本地预置，官方」+ 原型 9.1/12.1 的官方技能集合）。
 * 迁移/启动时按 slug 幂等插入（MarketService.seedBuiltins）：已存在即跳过。
 * status 一律 PUBLISHED、source='builtin'、publisher 为空（前端显示「官方」）。
 */
export interface BuiltinListingSeed {
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  type: string;
  license: string;
  compatible_clients: string[];
  mcp_dependencies: SkillMcpDependency[];
  current_version: string;
  content: SkillContent;
}

const CLIENTS = ['Claude Code', 'Qoder', 'Codex'];

type SeedBlock = SkillContent['blocks'][number];

function block(block: SeedBlock): SeedBlock {
  return block;
}

export const BUILTIN_LISTINGS: BuiltinListingSeed[] = [
  {
    slug: 'code-review',
    name: '代码审查',
    description: '对代码 diff 做风格、安全、逻辑三层审查，输出结构化审查报告。',
    category: '质量保障',
    tags: ['review', 'quality', 'workflow'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '加载审查上下文',
          prompt: '阅读待审查的代码 diff 及其关联文件，理解改动意图。',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '三层审查',
          steps: ['风格检查：命名、格式、注释规范', '安全检查：注入、越权、敏感信息泄漏', '逻辑检查：边界条件、错误处理、并发风险'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'decision',
          title: '是否发现问题',
          condition: '审查发现需要修复的问题',
          next: [
            { when: '是', to: 'b4' },
            { when: '否', to: 'b5' },
          ],
        }),
        block({
          id: 'b4',
          kind: 'prompt',
          title: '输出问题清单',
          prompt: '按严重程度列出问题：位置、描述、修复建议。',
          next: [{ when: '', to: 'b5' }],
        }),
        block({ id: 'b5', kind: 'prompt', title: '输出报告', prompt: '汇总为审查报告：结论、问题清单、整体建议。' }),
      ],
    },
  },
  {
    slug: 'bug-fix',
    name: '缺陷修复',
    description: '根据缺陷描述定位根因、给出最小修复方案并验证回归影响面。',
    category: '质量保障',
    tags: ['debug', 'fix'],
    type: 'flow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'step',
          title: '定位根因',
          steps: ['复现缺陷路径', '用二分法缩小可疑改动范围', '确认根因'],
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'decision',
          title: '是否可最小修复',
          condition: '修复不超过三个文件且不改变对外接口',
          next: [
            { when: '是', to: 'b3' },
            { when: '否', to: 'b4' },
          ],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '实施修复',
          prompt: '给出最小 diff 修复，并说明为什么该修复不会引入回归。',
          next: [{ when: '', to: 'b5' }],
        }),
        block({
          id: 'b4',
          kind: 'prompt',
          title: '升级处理',
          prompt: '修复面过大：输出修复方案设计与拆分建议，交给人工决策。',
        }),
        block({
          id: 'b5',
          kind: 'step',
          title: '验证',
          steps: ['针对缺陷补充回归测试', '运行相关测试套件'],
        }),
      ],
    },
  },
  {
    slug: 'unit-testing',
    name: '单元测试',
    description: '为指定模块设计并编写单元测试，覆盖正常路径、边界与异常分支。',
    category: '测试',
    tags: ['test', 'unit-test'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.1.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'step',
          title: '分析被测代码',
          steps: ['列出公共接口与分支', '识别边界值与等价类'],
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '设计用例矩阵',
          prompt: '输出用例矩阵：用例名、输入、期望输出、覆盖分支。',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '编写测试',
          prompt: '按项目既有测试框架与风格编写测试代码，mock 外部依赖。',
        }),
      ],
    },
  },
  {
    slug: 'performance-optimization',
    name: '性能优化',
    description: '分析热点路径，定位性能瓶颈，给出可量化的优化方案与验证方法。',
    category: '重构',
    tags: ['performance', 'profiling'],
    type: 'flow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '建立基线',
          prompt: '先运行/推演现有基准，记录耗时与内存基线数据。',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '定位瓶颈',
          steps: ['按 80/20 找热点路径', '区分 CPU/IO/锁竞争'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '优化并复测',
          prompt: '逐项实施优化并复测，输出前后对比数据；无收益的优化回滚。',
        }),
      ],
    },
  },
  {
    slug: 'security-scan',
    name: '安全扫描',
    description: '按 OWASP 常见漏洞清单扫描代码与依赖，输出风险等级与修复建议。',
    category: '质量保障',
    tags: ['security', 'owasp'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'step',
          title: '静态扫描',
          steps: ['注入类：SQL/命令/路径拼接', '越权与鉴权缺失', '敏感信息硬编码'],
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '依赖扫描',
          steps: ['列出直接依赖的已知 CVE', '评估可升级性'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'decision',
          title: '是否存在高危项',
          condition: '发现高危或严重等级风险',
          next: [
            { when: '是', to: 'b4' },
            { when: '否', to: 'b5' },
          ],
        }),
        block({
          id: 'b4',
          kind: 'human',
          title: '人工确认',
          humanInstruction: '存在高危风险，请人工确认处理优先级',
        }),
        block({
          id: 'b5',
          kind: 'prompt',
          title: '输出报告',
          prompt: '按风险等级汇总：位置、漏洞类型、修复建议。',
        }),
      ],
    },
  },
  {
    slug: 'regression-testing',
    name: '回归测试',
    description: '根据改动影响面选取回归范围，执行测试并输出通过率与风险提示。',
    category: '测试',
    tags: ['test', 'regression'],
    type: 'steps',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'step',
          title: '圈定范围',
          steps: ['由 diff 推导受影响模块', '选取直接与间接关联的测试集'],
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '执行并汇总',
          prompt: '运行回归测试集，输出通过率、失败用例分析与风险提示。',
        }),
      ],
    },
  },
  {
    slug: 'deployment-pipeline',
    name: '部署流程',
    description: '按检查单执行发布前检查、灰度发布与回滚预案演练。',
    category: '部署',
    tags: ['deploy', 'release'],
    type: 'flow',
    license: 'Apache-2.0',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'step',
          title: '发布前检查',
          steps: ['确认版本号与变更清单', '确认数据库迁移已评审', '确认回滚预案可用'],
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'human',
          title: '发布审批',
          humanInstruction: '发布需要人工审批确认',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'step',
          title: '灰度发布',
          steps: ['小流量发布并观察核心指标', '逐步放量到全量'],
        }),
      ],
    },
  },
  {
    slug: 'doc-generation',
    name: '文档生成',
    description: '从代码与变更记录生成/更新接口文档与变更日志，保持文档与实现一致。',
    category: '文档',
    tags: ['docs', 'changelog'],
    type: 'prompt',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '收集素材',
          prompt: '阅读模块代码、注释与近期提交，提取对外可见的行为变化。',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '生成文档',
          prompt: '按项目文档模板更新接口文档；为版本生成变更日志（新增/变更/修复/破坏性）。',
        }),
      ],
    },
  },
  {
    slug: 'commit-message',
    name: '提交信息生成',
    description: '读取 staged diff 生成符合 Conventional Commits 规范的提交信息，含正文与破坏性变更标注。',
    category: '开发流程',
    tags: ['git', 'commit', 'conventional-commits'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '读取变更',
          prompt: '执行 git diff --staged 阅读暂存区改动，归纳本次变更的目的与影响范围。变更说明：{{input.change_notes}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'decision',
          title: '是否为原子提交',
          condition: 'staged 改动只包含一个逻辑变更',
          next: [
            { when: '是', to: 'b3' },
            { when: '否', to: 'b4' },
          ],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '生成提交信息',
          prompt:
            '按 Conventional Commits 生成：type(scope): 简洁祈使句标题（≤50 字符）；正文说明动机与副作用（≤72 字符/行）；破坏性变更标注 ! 与 BREAKING CHANGE。输出到 {{task.title}} 对应的提交。',
          next: [{ when: '', to: 'b5' }],
        }),
        block({
          id: 'b4',
          kind: 'human',
          title: '人工拆分确认',
          humanInstruction: 'staged 改动包含多个逻辑变更，建议按功能拆分后分批提交，请人工确认拆分方式',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b5',
          kind: 'output',
          title: '输出结果',
          name: 'commit_message',
          valueType: 'text',
        }),
      ],
    },
  },
  {
    slug: 'readme-generation',
    name: 'README 生成',
    description: '从项目结构与代码生成结构化 README：简介、快速开始、配置说明与常见问题。',
    category: '文档',
    tags: ['readme', 'docs', 'onboarding'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '分析项目',
          prompt:
            '阅读 package.json/构建脚本与目录结构，识别技术栈、入口、构建与运行命令。项目路径：{{input.project_path}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '提取关键信息',
          steps: ['项目定位与核心功能', '安装与快速开始命令', '必填环境变量与配置项', '已有 README 可保留的段落'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '撰写 README',
          prompt:
            '生成 README：项目简介、功能特性、快速开始、配置说明（表格）、目录结构、常见问题。语言风格与项目现有文档保持一致，命令必须来自真实构建脚本而非猜测。',
        }),
      ],
    },
  },
  {
    slug: 'refactoring-advice',
    name: '重构建议',
    description: '识别代码坏味道，给出分级重构方案、收益评估与安全的重构步骤序列。',
    category: '重构',
    tags: ['refactor', 'clean-code', 'code-smell'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '扫描坏味道',
          prompt:
            '阅读目标代码 {{input.code_path}}，识别坏味道：过长函数、重复代码、过深嵌套、发散/霰弹式修改、职责混杂。列出位置与证据。',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'decision',
          title: '是否有测试保护',
          condition: '目标代码存在可运行的单元测试覆盖',
          next: [
            { when: '是', to: 'b3' },
            { when: '否', to: 'b4' },
          ],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '输出重构方案',
          prompt:
            '按优先级输出方案：坏味道、对应重构手法（如提取函数/引入参数对象/以多态取代条件）、预期收益、单步可验证的重构步骤序列，每步后运行测试。',
          next: [{ when: '', to: 'b5' }],
        }),
        block({
          id: 'b4',
          kind: 'step',
          title: '先补特征测试',
          steps: ['为现有行为编写特征测试固化当前输出', '再回到重构方案评估'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b5',
          kind: 'human',
          title: '方案评审',
          humanInstruction: '重构涉及接口变更或跨模块调整时，请人工确认方案后再实施',
        }),
      ],
    },
  },
  {
    slug: 'regex-explain',
    name: '正则解释与调试',
    description: '逐段解释正则表达式含义，标注陷阱（贪婪、回溯、边界），并给出测试样例验证。',
    category: '效率',
    tags: ['regex', 'explain', 'debug'],
    type: 'prompt',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'input',
          title: '待解释正则',
          name: 'regex',
          valueType: 'text',
          required: true,
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '逐段解释',
          prompt:
            '对正则 {{input.regex}} 逐 token 分段解释：匹配目标、量词贪婪性、分组是否捕获、锚点与边界。使用目标语言 {{input.language}} 的正则方言说明差异。',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '陷阱与样例',
          prompt:
            '指出潜在问题：灾难性回溯、误匹配边界、多行/Unicode 开关影响；给出 3 个匹配与 3 个不匹配的测试样例及预期。若用户意图明确，附一条更简洁或更安全的等价写法。',
        }),
      ],
    },
  },
  {
    slug: 'sql-optimization',
    name: 'SQL 优化',
    description: '分析慢 SQL 的执行计划，给出索引设计、改写建议与前后成本对比。',
    category: '重构',
    tags: ['sql', 'database', 'index'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '读取执行计划',
          prompt:
            '对慢 SQL 使用 EXPLAIN（ANALYZE）获取执行计划，标注全表扫描、嵌套循环、排序/溢出到磁盘的节点。SQL：{{input.sql}}，表结构：{{input.schema}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '逐项诊断',
          steps: ['过滤条件的选择性与现有索引匹配度', 'JOIN 顺序与连接键索引', 'SELECT * 与覆盖索引机会', '隐式类型转换与函数包裹列导致索引失效'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '输出优化方案',
          prompt:
            '输出：建议索引（含列顺序理由）、SQL 改写（如 EXISTS 替换 IN、分页游标化）与预期代价变化。区分「可直接执行」与「需要 DBA 评估（锁表/写放大）」两类建议。',
          next: [{ when: '', to: 'b4' }],
        }),
        block({
          id: 'b4',
          kind: 'human',
          title: '索引变更确认',
          humanInstruction: '创建索引会带来写入开销与在线 DDL 锁风险，请人工评估后在低峰期执行',
        }),
      ],
    },
  },
  {
    slug: 'api-design-review',
    name: 'API 设计评审',
    description: '按 RESTful 规范与一致性原则评审接口设计，输出资源建模、错误码与版本化改进项。',
    category: '开发流程',
    tags: ['api', 'rest', 'design-review'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '收集接口定义',
          prompt: '阅读待评审的接口定义（路由/DTO/OpenAPI）：{{input.api_spec}}，整理资源、方法与状态码清单。',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '规范评审',
          steps: ['资源命名：名词复数、层级不超两层、无动词路径', 'HTTP 语义：方法幂等性、状态码准确、分页/过滤/排序约定', '错误结构：统一错误码与可定位的 message', '兼容性：破坏性变更是否走新版本/新字段'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'decision',
          title: '是否存在破坏性变更',
          condition: '改动删除/重命名了对外字段或改变了既有语义',
          next: [
            { when: '是', to: 'b4' },
            { when: '否', to: 'b5' },
          ],
        }),
        block({
          id: 'b4',
          kind: 'human',
          title: '破坏性变更评审',
          humanInstruction: '存在破坏性变更，需人工评估迁移方案与客户端兼容窗口',
          next: [{ when: '', to: 'b5' }],
        }),
        block({
          id: 'b5',
          kind: 'prompt',
          title: '输出评审报告',
          prompt: '输出评审报告：结论（通过/有条件通过/驳回）、问题清单（按阻塞/建议分级）、改进示例（给出修改前后的路由或 DTO 片段）。',
        }),
      ],
    },
  },
  {
    slug: 'code-explain',
    name: '代码解释',
    description: '面向指定读者水平解释代码片段的功能、执行流程与设计意图，标注风险点。',
    category: '效率',
    tags: ['explain', 'onboarding', 'reading'],
    type: 'prompt',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'input',
          title: '目标代码',
          name: 'code',
          valueType: 'text',
          required: true,
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '结构化解释',
          prompt:
            '解释代码 {{input.code}}：先用一句话概括做什么；再按执行顺序分步说明关键逻辑；解释不直观的写法（位运算、闭包、并发原语等）。读者水平：{{input.reader_level}}',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '上下文与风险',
          prompt:
            '补充：该代码依赖的外部契约（输入/输出/副作用），以及阅读中发现的潜在风险（边界、异常、竞态）——只标注，不顺手修改。',
        }),
      ],
    },
  },
  {
    slug: 'doc-translation',
    name: '文档翻译',
    description: '翻译技术文档，保留代码块、术语表与链接结构，输出术语对照表。',
    category: '写作',
    tags: ['translation', 'i18n', 'docs'],
    type: 'steps',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'input',
          title: '翻译设置',
          name: 'target_language',
          valueType: 'text',
          required: true,
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '建立术语表',
          prompt:
            '通读文档，提取技术术语与专有名词，确定译法（不翻译的保留原文：命令、API 名、库名），形成术语对照表。',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '执行翻译',
          prompt:
            '将文档翻译为 {{input.target_language}}：代码块与命令保持原样，仅翻译注释；保留 Markdown 结构、锚点链接与 frontmatter key；语句贴合目标语言技术写作习惯，避免逐字直译。',
        }),
      ],
    },
  },
  {
    slug: 'weekly-report',
    name: '周报生成',
    description: '从任务看板与提交记录汇总本周进展、风险与下周计划，输出结构化周报。',
    category: '写作',
    tags: ['report', 'weekly', 'summary'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '收集素材',
          prompt:
            '汇总素材：本周完成的任务 {{task.title}} 及其状态、关联提交记录、遗留未办。补充人工输入：{{input.extra_notes}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '撰写周报',
          prompt:
            '按「本周进展（结果导向，量化产出）/ 关键决策与变更 / 风险与阻塞（附需要的支持）/ 下周计划」四段撰写，控制在一屏以内，删除过程性描述只保留结果与影响。',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'human',
          title: '人工校对',
          humanInstruction: '周报代表团队对外沟通口径，发送前请人工校对事实与措辞',
        }),
      ],
    },
  },
  {
    slug: 'pr-description',
    name: 'PR 描述生成',
    description: '根据分支与主干 diff 生成 PR 描述：变更摘要、影响面、测试证据与回滚方式。',
    category: '开发流程',
    tags: ['pr', 'git', 'review'],
    type: 'prompt',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '分析差异',
          prompt:
            '对比当前分支与主干的 diff 与提交列表，归纳变更动机、修改点与关联任务（{{task.title}}）。补充背景：{{input.context}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '撰写 PR 描述',
          prompt:
            '输出 PR 描述模板：## 变更内容（要点式）、## 为什么（动机与方案取舍）、## 影响面（调用方/配置/数据）、## 测试（已运行的测试与结果，未覆盖项如实标注）、## 回滚方式。禁止编造未执行的测试结果。',
        }),
      ],
    },
  },
  {
    slug: 'coverage-gap-analysis',
    name: '覆盖率缺口分析',
    description: '结合覆盖率报告与代码风险度，找出值得补测的缺口并排定补测优先级。',
    category: '测试',
    tags: ['coverage', 'test', 'quality'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '读取覆盖率',
          prompt:
            '读取覆盖率报告（如 coverage-summary），列出行/分支覆盖率低于阈值的文件：{{input.coverage_report}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '风险加权',
          steps: ['按变更频率（近期提交次数）加权', '按业务关键性（鉴权、资金、状态机）加权', '排除纯类型定义、常量等无需测试的文件'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '输出补测清单',
          prompt:
            '输出优先级排序的补测清单：文件、未覆盖分支描述、建议用例（happy path + 边界 + 异常）、预估收益。明确标注「不值得补测」的部分及理由，避免为数字而测。',
        }),
      ],
    },
  },
  {
    slug: 'incident-postmortem',
    name: '事故复盘',
    description: '按时间线梳理事故经过，定位根因（5 Whys），输出可执行的改进项与责任人。',
    category: '文档',
    tags: ['postmortem', 'incident', 'blameless'],
    type: 'workflow',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'prompt',
          title: '整理时间线',
          prompt:
            '根据告警记录、操作日志与沟通记录整理事故时间线：发现、响应、定位、恢复各环节的时间点与动作。事故概述：{{input.incident_summary}}',
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'prompt',
          title: '根因分析',
          prompt:
            '用 5 Whys 追问到底：区分触发条件与系统性根因（流程、监控、架构），避免把根因归咎于个人操作失误。列出所有贡献因素。',
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '输出复盘报告',
          prompt:
            '按 blameless 模板输出：影响范围（量化）、时间线、根因、教训、改进项（每项含负责人、期限、验收标准，区分预防/检测/缓解三类）。',
          next: [{ when: '', to: 'b4' }],
        }),
        block({
          id: 'b4',
          kind: 'human',
          title: '改进项评审',
          humanInstruction: '改进项涉及跨团队排期与资源投入，请人工评审优先级后归档',
        }),
      ],
    },
  },
  {
    slug: 'log-analysis',
    name: '日志分析',
    description: '从错误日志中聚类问题模式，定位可疑代码路径并输出排查结论与证据链。',
    category: '效率',
    tags: ['logs', 'debugging', 'triage'],
    type: 'steps',
    license: 'MIT',
    compatible_clients: CLIENTS,
    mcp_dependencies: [],
    current_version: 'v1.0.0',
    content: {
      entryBlockId: 'b1',
      blocks: [
        block({
          id: 'b1',
          kind: 'input',
          title: '日志输入',
          name: 'logs',
          valueType: 'text',
          required: true,
          next: [{ when: '', to: 'b2' }],
        }),
        block({
          id: 'b2',
          kind: 'step',
          title: '聚类与降噪',
          steps: ['按错误签名（类型+位置）聚类去重', '统计各簇出现频次与首次/最后出现时间', '剔除与问题无关的噪声日志'],
          next: [{ when: '', to: 'b3' }],
        }),
        block({
          id: 'b3',
          kind: 'prompt',
          title: '定位与结论',
          prompt:
            '对主要错误簇：结合堆栈定位到源码位置，说明可疑原因与证据链（日志行 → 代码路径），给出下一步排查动作或修复假设。按影响面排定处理顺序。',
        }),
      ],
    },
  },
];
