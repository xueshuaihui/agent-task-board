import { useEffect, useRef, type RefObject } from 'react';

/**
 * 两个 hook 都把回调收进 ref：调用方几乎总是传内联函数/数组字面量，
 * 让它们进依赖数组等于每次渲染重挂监听器（菜单会在渲染风暴里反复开关）。
 */

/** Esc 关闭：Dialog / Drawer / Menu 共用（10.5 的弹窗都有 × 与键盘退出）。 */
export function useEscape(active: boolean, onEscape: () => void): void {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handlerRef.current();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [active]);
}

/** 点击外部关闭：菜单与下拉用。`refs` 里任意一个元素内的点击都不算「外部」。 */
export function useClickOutside(
  active: boolean,
  refs: readonly (RefObject<HTMLElement | null> | null)[],
  onOutside: () => void,
): void {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const handlerRef = useRef(onOutside);
  handlerRef.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const listener = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      for (const ref of refsRef.current) {
        if (ref?.current && ref.current.contains(target)) return;
      }
      handlerRef.current();
    };
    // 用 mousedown 而不是 click：触发按钮的 click 冒泡上来会「关掉又立刻打开」。
    document.addEventListener('mousedown', listener);
    return () => document.removeEventListener('mousedown', listener);
  }, [active]);
}

/** 弹层打开时锁背景滚动，避免抽屉后面的看板列跟着滚（2.1 内容区是唯一滚动源）。 */
export function useLockBodyScroll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
