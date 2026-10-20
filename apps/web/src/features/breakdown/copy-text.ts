/**
 * #4「复制唤起指令」的剪贴板写入：
 * 先走 `navigator.clipboard.writeText`（浏览器/WebView 大概率可用），
 * 失败或被权限挡下时用 textarea + `document.execCommand('copy')` 兜底。
 * 返回是否成功，由调用方决定 toast 文案（本仓既有的 settings/use-copy 是 Hook 形态，
 * 这里要能在同一处给 pending 卡片与会话横幅复用，故写成纯异步函数）。
 */
export async function copyTextWithFallback(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* WebView 无剪贴板权限：落到 textarea 兜底 */
  }
  if (typeof document === 'undefined') return false;
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea?.parentNode?.removeChild(textarea);
  }
}
