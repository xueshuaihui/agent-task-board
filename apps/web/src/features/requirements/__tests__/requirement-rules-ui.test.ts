import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasInheritedContext } from '../requirement-context';

/**
 * #8 需求级执行规则与强制技能的可见面源码闸（web 无 jsdom，口径同其他源码扫描测试）。
 *
 * 钉四块：
 * 1. 需求抽屉有独立「执行规则」Tab，textarea 20000 上限、PATCH 空串归 null、
 *    技能走 taskSkillsApi.set；
 * 2. 需求卡徽标只读卡片布尔 `has_execution_rules`，不展示规则全文；
 * 3. 子任务概览渲染「继承自需求（强制）」块，且用纯函数判据决定是否渲染；
 * 4. 子任务技能页标注「需求强制」/「任务」，需求技能只读、不在子任务侧解绑。
 */

const WEB_SRC = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(WEB_SRC, path), 'utf8');

const drawer = read('features/requirements/requirement-drawer.tsx');
const requirementsPage = read('features/requirements/requirements-page.tsx');
const overview = read('features/task-detail/tabs/overview.tsx');
const skillsTab = read('features/task-detail/tabs/skills.tsx');
const apiTypes = read('api/types.ts');

describe('需求抽屉：执行规则 Tab 与两个独立保存动作', () => {
  it('「执行规则」Tab 排在「子任务」之后且默认不隐藏', () => {
    expect(drawer).toContain("{ value: 'subtasks', label: '子任务' }");
    expect(drawer).toContain("{ value: 'rules', label: '执行规则' }");
    expect(drawer.indexOf("{ value: 'rules'")).toBeGreaterThan(
      drawer.indexOf("{ value: 'subtasks'"),
    );
  });

  it('规则 textarea 预填 execution_rules，长度上限 20000，空串保存为 null', () => {
    expect(drawer).toContain('detail.execution_rules ??');
    expect(drawer).toContain('maxLength={20000}');
    expect(drawer).toMatch(/api\.tasks\.patch\(detail\.id, \{ execution_rules: value \}\)/);
    expect(drawer).toContain("rules.trim() === '' ? null : rules");
  });

  it('规则与技能是两个独立 mutation：PATCH 规则、taskSkillsApi.set 绑定', () => {
    expect(drawer).toContain('const saveRules = useApiMutation(');
    expect(drawer).toContain('const setSkills = useApiMutation(');
    expect(drawer).toContain('taskSkillsApi.set(');
    expect(drawer).not.toContain('统一保存');
    for (const key of ['qk.taskRoot(detail.id)', 'qk.boardRoot', 'qk.tasksRoot']) {
      expect(drawer).toContain(key);
    }
  });

  it('强制技能说明写清注入与领取时快照', () => {
    expect(drawer).toContain('这些技能会随需求强制注入子任务执行，领取时快照');
    expect(drawer).toContain('SkillPicker');
    expect(drawer).toContain('useSkills');
  });
});

describe('需求卡：只显示 has_execution_rules 徽标', () => {
  it('徽标读卡片布尔并显示「有执行规则」', () => {
    expect(requirementsPage).toContain('task.has_execution_rules');
    expect(requirementsPage).toContain('有执行规则');
  });

  it('不把规则全文带上卡面', () => {
    expect(requirementsPage).not.toContain('task.execution_rules');
  });
});

describe('子任务概览：继承自需求（强制）只读块', () => {
  it('无条件调用 useTaskOverview，父 id 为空时自动 disabled', () => {
    expect(overview).toContain('useTaskOverview(detail.parent?.id ?? null)');
    expect(overview).toContain('继承自需求（强制）');
    expect(overview).toContain('whitespace-pre-wrap');
    expect(overview).toContain('openRequirement(requirement.id)');
    expect(overview).toContain('useSkills(undefined, { enabled: Boolean(detail.parent?.id) })');
  });

  it('渲染判据走 hasInheritedContext：无规则且无需求技能时整块不渲染', () => {
    expect(overview).toContain('hasInheritedContext');
    expect(overview).toContain(
      'if (!hasInheritedContext(requirement.execution_rules, skills.length)) return null;',
    );
    expect(hasInheritedContext(null, 0)).toBe(false);
  });
});

describe('子任务技能页：来源标注与需求技能只读', () => {
  it('已绑定技能行标「需求强制」/「任务」', () => {
    expect(skillsTab).toContain("source={parentSkillIds.has(ref.skill_id) ? 'requirement' : 'task'}");
    expect(skillsTab).toContain('需求强制');
    expect(skillsTab).toContain("'任务'");
  });

  it('需求技能不在子任务侧解绑：解绑按钮只在 source === task 时渲染', () => {
    expect(skillsTab).toContain("{source === 'task' ? (");
  });

  it('父需求有技能但任务未绑定时，只读小节仍列出', () => {
    expect(skillsTab).toContain('继承自需求（只读）');
    expect(skillsTab).toContain('inheritedOnly');
  });
});

describe('api/types.ts：契约字段齐全', () => {
  it('TaskCard.has_execution_rules / TaskDetail.execution_rules / TaskCreateInput.execution_rules', () => {
    expect(apiTypes).toMatch(/interface TaskCard[\s\S]*?has_execution_rules: boolean;/);
    expect(apiTypes).toMatch(
      /interface TaskDetail[\s\S]*?execution_rules: string \| null;[\s\S]*?execution_rules_updated_at: string \| null;/,
    );
    expect(apiTypes).toMatch(
      /interface TaskCreateInput[\s\S]*?execution_rules\?: string \| null;/,
    );
  });
});
