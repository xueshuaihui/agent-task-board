import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnimatePresence, motion } from 'motion/react';

/**
 * 钉死 v0.0.4 §7.4 走查发现的那条 console error 不再回来。
 *
 * 报错原文（dev 打开 #/board、纯挂载不做任何交互即 3 条 level=error）：
 * 「Warning: Function components cannot be given refs. Attempts to access this ref will fail.
 *  Did you mean to use React.forwardRef()?  Check the render method of `Primitive.div.Slot`.」
 *
 * 落点是**写在 Radix Portal 里的 `<AnimatePresence>` 本身**，不是 Radix Content、也不是 motion 元素：
 * TooltipPortal / DialogPortal 内部渲染的是
 * `<Presence present><Portal asChild>{children}</Portal></Presence>`
 * （@radix-ui/react-tooltip/dist/index.js:268、@radix-ui/react-dialog/dist/index.js:145），
 * 那个 `asChild` 走 @radix-ui/react-slot，Slot 把 Presence 合成的 ref 用
 * `cloneElement(child, { ref })` 转给自己的唯一子节点
 * （@radix-ui/react-slot/dist/index.js:92-94）；子节点是普通函数组件 AnimatePresence 时
 * React 丢ref 并报警（React 18 校验点 react-dom/cjs/react-dom.development.js:20204）。
 * forceMount 让那层 Presence/Portal 常驻，所以纯挂载就报、与 open 无关；三条 = 按报错元素
 * 的下发行去重后的结果（tooltip.tsx:31 / dialog.tsx:58 / notification-center.tsx:90）。
 *
 * 修法是「AnimatePresence 在外、`Portal forceMount` 在内」（与 popover/menu 同构），于是这个 ref
 * 经 Content（forwardRef）落到 motion 的真实节点上。
 *
 * 本仓 vitest 无 DOM 环境（未装 jsdom / @testing-library，本片也不加依赖），所以这里钉的是
 * 「报错机制的前提 + 四个浮层的接线形状」；浏览器里 console 是否归零、退场是否真播完，
 * 仍需真机补验（见交付汇报的未验证清单）。
 */

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 四个 forceMount 浮层：报错的三条来源 + 同形状的抽屉（走查时任务详情未挂载故未现）。 */
const OVERLAY_FILES = [
  'components/ui/tooltip.tsx',
  'components/ui/dialog.tsx',
  'components/ui/drawer.tsx',
  'app/notification-center.tsx',
];

/** 只留代码：三处注释里原样写着 `<Portal asChild>` / `<AnimatePresence>`，不排除会自匹配。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Radix `*Portal` 开标签后紧跟的那个元素——报错与否只取决于它是 AnimatePresence 还是 Content。 */
const PORTAL_DIRECT_CHILD = /<([A-Za-z][\w.]*Portal)\b[^>]*>\s*<AnimatePresence\b/g;

/** 递归列 src 下的 .tsx（跳过 __tests__，同上理由）。 */
function listSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...listSources(full));
    } else if (entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

describe('浮层的 AnimatePresence / Radix Portal 嵌套顺序（console 零 error 的前提）', () => {
  it('AnimatePresence 是普通函数组件——它当不了 Radix Slot 的 ref 落点（故不能回退成旧写法）', () => {
    expect(typeof AnimatePresence).toBe('function');
    // forwardRef / 类组件带 $$typeof；函数组件没有 ⇒ Slot 挂上去就是丢弃 + 报警。
    expect((AnimatePresence as { $$typeof?: symbol }).$$typeof).toBeUndefined();
  });

  it('换序后 ref 有合法落点：motion.* 是 forwardRef 组件（Slot 的子节点 Content 也是）', () => {
    expect(motion.span.$$typeof).toBe(Symbol.for('react.forward_ref'));
    expect(motion.aside.$$typeof).toBe(Symbol.for('react.forward_ref'));
  });

  it('AnimatePresence 自身不渲染 DOM 节点 ⇒ 提到 Portal 外不改变浮层的盒子结构与 z-index 语境', () => {
    const html = renderToStaticMarkup(
      createElement(AnimatePresence, null, createElement('span', { 'data-probe': 'child' }, 'x')),
    );
    expect(html).toBe('<span data-probe="child">x</span>');
  });

  it('全 src 不存在「Portal 直接子节点是 AnimatePresence」的旧写法', () => {
    const offenders: string[] = [];
    for (const file of listSources(SRC_ROOT)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const match of code.matchAll(PORTAL_DIRECT_CHILD)) {
        offenders.push(`${relative(SRC_ROOT, file)} <- ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('四个浮层一律 AnimatePresence 在外、Portal forceMount 在内，Content 的 forceMount 未掉（§4.3）', () => {
    for (const rel of OVERLAY_FILES) {
      const code = stripComments(readFileSync(join(SRC_ROOT, rel), 'utf8'));
      const presenceAt = code.indexOf('<AnimatePresence');
      const portalAt = code.search(/<[A-Za-z][\w.]*Portal\b/);
      expect(presenceAt, `${rel} 应使用 AnimatePresence`).toBeGreaterThan(-1);
      expect(portalAt, `${rel} 应使用 Radix Portal`).toBeGreaterThan(-1);
      // 顺序：AnimatePresence 先出现（包在外面），Portal 在其内。
      expect(presenceAt < portalAt, `${rel}: AnimatePresence 必须在 Portal 之外`).toBe(true);
      // 退场可播的 forceMount 缺一不可：Portal（Presence 常驻）+ Content（不被 Radix 提前卸载）。
      expect(new RegExp('<[A-Za-z][\\w.]*Portal\\s+forceMount').test(code), `${rel}: Portal forceMount`).toBe(true);
      expect(/\.Content\b[\s\S]{0,200}?\bforceMount/.test(code), `${rel}: Content forceMount`).toBe(true);
      // 遮罩若存在也必须带 forceMount（Dialog / Drawer / 通知中心三处有）。
      if (/\.Overlay\b/.test(code)) {
        expect(/\.Overlay\b[^\n]*\bforceMount/.test(code), `${rel}: Overlay forceMount`).toBe(true);
      }
    }
  });
});
