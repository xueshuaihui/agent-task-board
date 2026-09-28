import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

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
 * C 段（归属下拉 / 组名 badge）与 D 段（labels/errors 中文）见后续提交。
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
