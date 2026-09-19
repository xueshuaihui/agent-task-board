import type { SkillContent, SkillMcpDependency } from '../skills/skills.dto';

/**
 * 内置技能种子（8.8 技能源「内置技能：本地预置，官方」+ 原型 9.1/12.1 的八个官方技能）。
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
];
