import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_LABEL } from '@/lib/labels';
import { ERROR_CODE_COPY } from '@/api/errors';

/**
 * §19.15·87/88/93⑥（r6 R1b-C）：「分组」概念从 web UI 整体下线后的源码闸。
 *
 * 前身是 `group-open-target.test.ts`（钉 groups-page「打开」跳列表路由的行为）——
 * 被钉页面已随 R1b-B 删除，按 93⑥「改写而非删除」的口径，本闸改钉**新不变量**：
 * ① 分组管理界面三件套（含零消费者的 group-glyph）在源码里不复存在；
 * ② router 不再把 `/groups` 挂为活动路由，且存在 `/groups → /requirements` 的
 *    旧深链重定向映射（兼容表 + 纯函数直测，query 必须原样保留）；
 * ③ 导航第二项是 requirements、label 是「需求」，集合与顺序不变。
 *
 * **R3 追加（§19.15·90，2026-09-28）**：同一闸文件继续钉「分组」可见面清零的三件事——
 * 列表作用域 chip 改走 `requirements` 维、`filtersFromSearch` 不再水合 `groups`、
 * 分节菜单删 `group` 维候选并改措辞「分节方式 / 不分节」（末尾两个 describe）。
 * R3-C 追加「归属可见面清零」段（两处归属下拉 + 拆解组名 badge），R3-D 追加
 * 「中文口径与死链」段（labels 动作中文名 / errors 兜底文案 / 死链注释闸）。
 *
 * 环境口径同 W2 各闸：本仓 vitest 无 jsdom，文件存在性/源码字符串用
 * `readFileSync`/`existsSync`；router 模块装配期读一次 hash（`create` 初值跑
 * `readHash`），与 `filter-prefs.test.ts` 同法先 stub 最小 `window` 再动态 import，
 * 因此重定向映射与 NAV_ORDER/ROUTES 按**导出真值**直测，不只测字符串。UI 未真机验证。
 */

const GROUPS_DIR = join(__dirname, '..');
const FEATURES_DIR = join(GROUPS_DIR, '..');
const APP_DIR = join(GROUPS_DIR, '..', '..', 'app');

vi.stubGlobal('window', {
  location: { hash: '' },
  history: { replaceState: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
});
const { LEGACY_PATH_REDIRECTS, ROUTES, NAV_ORDER, rewriteLegacyLocation } = await import('@/app/router');

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('r6 源码闸：Group 管理界面在 web 不复存在（§19.15·88）', () => {
  it('分组页与新建/编辑、删除对话框、GroupGlyph 文件已删除', () => {
    for (const gone of [
      'groups-page.tsx',
      'group-form-dialog.tsx',
      'group-delete-dialog.tsx',
      'group-glyph.tsx',
    ]) {
      expect(existsSync(join(GROUPS_DIR, gone)), `features/groups/${gone} 不应存在`).toBe(false);
    }
  });

  it('barrel 不再导出任何界面组件，只留数据层出口（queries/use-group-scoped/types）', () => {
    const barrel = readFileSync(join(GROUPS_DIR, 'index.ts'), 'utf8');
    expect(barrel).not.toContain('GroupsPage');
    expect(barrel).not.toContain('GroupGlyph');
    expect(barrel).toContain("from './queries'");
    expect(barrel).toContain("from './use-group-scoped'");
  });

  it('壳层与侧栏无 Group 界面残留：PAGES 挂 RequirementsPage，图标改需求语义', () => {
    const app = readFileSync(join(APP_DIR, 'app.tsx'), 'utf8');
    expect(app).not.toContain('GroupsPage');
    expect(app).toContain('requirements: RequirementsPage');
    const sidebar = readFileSync(join(APP_DIR, 'sidebar.tsx'), 'utf8');
    // FolderTree 只允许出现在「为什么换图标」的注释里，不许再出现在 lucide import 块。
    const lucideImport = sidebar.slice(sidebar.indexOf('import {'), sidebar.indexOf("from 'lucide-react'"));
    expect(lucideImport).not.toContain('FolderTree');
    expect(sidebar).toContain('requirements: ListChecks');
  });
});

describe('r6 路由闸：#/groups 旧深链重定向而非活动路由/静默回落（§19.15·87）', () => {
  it("router 源码里 '/groups' 不再是任何路由的 path，兼容表在位", () => {
    const router = readFileSync(join(APP_DIR, 'router.tsx'), 'utf8');
    expect(router).not.toContain("path: '/groups'");
    expect(router).toContain("'/groups': '/requirements'");
    expect(LEGACY_PATH_REDIRECTS).toEqual({ '/groups': '/requirements' });
  });

  it('rewriteLegacyLocation：旧 path 换新、query 原样保留、非旧链与形近 path 不动', () => {
    expect(rewriteLegacyLocation('/groups')).toBe('/requirements');
    expect(rewriteLegacyLocation('/groups?x=1')).toBe('/requirements?x=1');
    expect(rewriteLegacyLocation('/groups?groups=a&status=REVIEW')).toBe('/requirements?groups=a&status=REVIEW');
    expect(rewriteLegacyLocation('/groups?')).toBe('/requirements?');
    expect(rewriteLegacyLocation('/board')).toBe('/board');
    expect(rewriteLegacyLocation('/tasks?status=REVIEW')).toBe('/tasks?status=REVIEW');
    // 前缀形近的未知 path 不被误改写（映射按整段 path 精确匹配）。
    expect(rewriteLegacyLocation('/groupsx')).toBe('/groupsx');
    expect(rewriteLegacyLocation('/requirements')).toBe('/requirements');
  });

  it('ROUTES 键改 requirements（path/label 新口径），groups 键不存在', () => {
    expect(Object.keys(ROUTES)).not.toContain('groups');
    expect(ROUTES.requirements.path).toBe('/requirements');
    expect(ROUTES.requirements.label).toBe('需求');
  });

  it('NAV_ORDER 集合与顺序不变，第二位是 requirements（看板/需求/技能/审核/设置）', () => {
    expect([...NAV_ORDER]).toEqual(['board', 'requirements', 'skills', 'review', 'settings']);
    expect(NAV_ORDER[1]).toBe('requirements');
  });
});

/**
 * §19.15·90（r6 R3-B）：列表页分节维度与作用域 chip 的清零闸。
 * 只钉**概念可见面**：菜单措辞、group 维候选、历史偏好词表、chip 读的维度。
 * `MenuProps['groups']` 这个属性名是菜单分节排版（同词不同义），显式钉它**不许**被改名带走。
 */
describe('r6 分节菜单闸：group 维候选删除、措辞改「分节方式 / 不分节」（§19.15·90）', () => {
  const dimensions = readFileSync(
    join(FEATURES_DIR, 'board', 'grouping', 'dimensions.ts'),
    'utf8',
  );
  const listPage = readFileSync(join(FEATURES_DIR, 'task-list', 'index.tsx'), 'utf8');
  const groupPref = readFileSync(join(FEATURES_DIR, 'task-list', 'group-pref.ts'), 'utf8');

  it('维度词表里没有 group：类型联合、GROUP_DIMENSIONS 条目、候选顺序三处都退场', () => {
    expect(dimensions).not.toMatch(/type GroupDimensionKey =[\s\S]*?'group'/);
    expect(dimensions).not.toMatch(/^\s{2}group:\s*\{/m);
    expect(dimensions).not.toMatch(/GROUPABLE_KEYS = \[[\s\S]*?'group'/);
    expect(dimensions).toContain("key: 'requirement'");
  });

  it('菜单触发器与「不分节」项用新措辞；不再出现「分组方式」「不分组」', () => {
    expect(listPage).toContain('分节方式');
    expect(listPage).toContain("label: '不分节'");
    expect(listPage).not.toContain('分组方式');
    expect(listPage).not.toContain('不分组');
  });

  it('菜单结构仍走 MenuProps[\'groups\'] 属性名（同词不同义，禁止为清零而改名）', () => {
    expect(listPage).toContain("MenuProps['groups']");
    expect(listPage).toContain('groups={groups}');
  });

  it('分节维度偏好词表去掉 group（历史值读取即回落不分节）', () => {
    expect(groupPref).not.toMatch(/VALID[^=]*=\s*\[[^\]]*'group'/);
    expect(groupPref).toContain("'requirement'");
  });

  it('节标题不再查分组缓存富化：task-list 只留 useTaskListWithGroups 一条数据腿引用', () => {
    expect(listPage).toContain("from '@/features/groups'");
    expect(listPage).not.toMatch(/\buseGroups\b/);
    expect(listPage).not.toMatch(/import \{ useGroups,/);
  });
});

/**
 * §19.15·90（r6 R3-A）：列表作用域 chip 改走 requirements 维。
 */
describe('r6 作用域 chip 闸：从 groups 维改走 requirements 维（§19.15·90）', () => {
  const panel = readFileSync(join(FEATURES_DIR, 'task-list', 'filter-panel.tsx'), 'utf8');
  const store = readFileSync(join(FEATURES_DIR, '..', 'app', 'store', 'filters.ts'), 'utf8');

  it('chip 文案 =「需求：」，读 requirements 维、清除也走 requirements 维', () => {
    expect(panel).toContain('需求：');
    expect(panel).toContain('state.requirements');
    expect(panel).toContain("setDimension('requirements', [])");
    expect(panel).not.toMatch(/state\.groups/);
    expect(panel).not.toContain("setDimension('groups'");
    expect(panel).not.toContain('个分组');
  });

  it('filtersFromSearch 不再水合 groups（列表腿与看板腿同口径剥离）', () => {
    expect(store).not.toMatch(/patch\.groups\s*=/);
    expect(store).not.toContain("listFrom(search, 'groups')");
  });
});

/**
 * §19.15·90（r6 R3-C）：三处归属可见面清零的源码闸——
 * 新建任务弹窗「分组」下拉并掉（归属只剩「挂到需求」写 parent_task_id）、
 * creation 编辑卡假归属口整块删除、拆解会话卡头的组名 badge 退场。
 * 字段级细钉各归本feature（creation-requirement-copy / ownership-single-field-source-gate），
 * 这里统一钉「Group 消费面不再出现在这三个文件」。
 */
describe('r6 归属可见面闸：两处归属下拉 + 拆解组名 badge 退场（§19.15·90）', () => {
  const createDialog = readFileSync(join(FEATURES_DIR, 'task-detail', 'create-task-dialog.tsx'), 'utf8');
  const creationDialog = readFileSync(join(FEATURES_DIR, 'creation', 'creation-edit-dialog.tsx'), 'utf8');
  const overlay = readFileSync(join(FEATURES_DIR, 'breakdown', 'breakdown-overlay.tsx'), 'utf8');

  it('create-task-dialog：「分组」下拉与 group 候选数据源全部退场', () => {
    expect(createDialog).not.toContain('useActiveGroups');
    expect(createDialog).not.toMatch(/label="分组"/);
    expect(createDialog).not.toContain('未分配分组');
    expect(createDialog).not.toContain('归档分组');
  });

  it('creation-edit-dialog：假归属口（显示需求、写分组）整块删除', () => {
    expect(creationDialog).not.toContain('useActiveGroups');
    expect(creationDialog).not.toContain('useRequirementOptions');
    expect(creationDialog).not.toMatch(/label="(需求|分组)"/);
    expect(creationDialog).not.toContain('creation-edit-requirement');
  });

  it('breakdown-overlay：组名 badge 与反查退场（BreakdownStatusBadge 是状态徽标，不在此列）', () => {
    expect(overlay).not.toContain('useActiveGroups');
    expect(overlay).not.toContain('groupName');
    expect(overlay).not.toMatch(/<Badge[\s/>]/);
    expect(overlay).toContain('BreakdownStatusBadge');
  });
});

/**
 * §19.15·90（r6 R3-D）：中文口径与死链。
 * labels/errors 属排障面文案——r6 后 group_* 审计只由 REST/Agent 或存量数据产生，
 * 中文改「需求容器…」（动作码不动）；GROUP_* 错误兜底不得再教用户去 UI 里做
 * 已不存在的操作（「先删除不用的分组」「不可删除或归档」这类承诺全部退场）。
 * 死链注释两处的在位闸：样式参照对象已删、分组页「查看任务」行为描述已收口。
 */
describe('r6 中文口径闸：审计动作改「需求容器」、错误文案不承诺 UI 操作（§19.15·90）', () => {
  const GROUP_ACTION_KEYS = ['group_change', 'group_archive', 'group_unarchive'] as const;

  it('三条 AUDIT 动作码原样保留，中文已是「需求容器…」、不再出现「分组」', () => {
    expect(AUDIT_ACTION_LABEL.group_change).toBe('需求容器变更');
    expect(AUDIT_ACTION_LABEL.group_archive).toBe('需求容器归档');
    expect(AUDIT_ACTION_LABEL.group_unarchive).toBe('需求容器取消归档');
    for (const key of GROUP_ACTION_KEYS) {
      expect(AUDIT_ACTION_LABEL[key]).not.toContain('分组');
    }
  });

  it('三条 GROUP_* 错误兜底文案：不出现误导的 UI 操作承诺', () => {
    const copy = [
      ERROR_CODE_COPY.GROUP_LIMIT_REACHED,
      ERROR_CODE_COPY.GROUP_DEFAULT_PROTECTED,
      ERROR_CODE_COPY.GROUP_ARCHIVED,
    ];
    for (const text of copy) {
      expect(text).not.toContain('分组页');
      expect(text).not.toContain('先删除');
      expect(text).not.toContain('不可删除或归档');
      // 陈述性口径：点明这是数据层/服务端约束，操作面在 REST/Agent。
      expect(text).toMatch(/REST\/Agent|数据层|服务端/);
    }
  });

  it('errors.ts 只动中文映射，动作码键面不增删（types.ts/client.ts 零改动红线的外圈闸）', () => {
    const errorsSource = readFileSync(join(FEATURES_DIR, '..', 'api', 'errors.ts'), 'utf8');
    for (const code of ['GROUP_LIMIT_REACHED', 'GROUP_DEFAULT_PROTECTED', 'GROUP_ARCHIVED']) {
      expect(errorsSource).toContain(`${code}:`);
    }
    expect(errorsSource).not.toMatch(/^\s*group_id\s*:/m);
  });
});

describe('r6 死链注释闸：样式参照与分组页行为描述不再指已删对象（§19.15·90）', () => {
  it('session-action-dialog 不再把已删除的 group-delete-dialog 当样式参照', () => {
    const source = readFileSync(join(FEATURES_DIR, 'breakdown', 'session-action-dialog.tsx'), 'utf8');
    expect(source).not.toContain('样式沿');
    // 允许以过去式解释该文件已随 r6 删除，但不作为在位引用。
    expect(source).toContain('已随 r6');
  });

  it('board/grouping/README 不再描述分组页「查看任务」行为（消费方接线只剩看板/列表/需求页）', () => {
    const readme = readFileSync(join(FEATURES_DIR, 'board', 'grouping', 'README.md'), 'utf8');
    expect(readme).not.toContain('查看任务');
    expect(readme).not.toContain("setDimension('groups'");
    expect(readme).toContain('不再写 `groups` 维');
  });
});
