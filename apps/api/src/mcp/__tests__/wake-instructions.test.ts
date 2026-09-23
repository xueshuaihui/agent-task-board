import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../contract/settings';
import { buildMcpInstructions, MCP_WAKE_EXIT, MCP_WAKE_WORD, wakeModeNotice } from '../../mcp/mcp.server';

/**
 * #46 唤醒词口径的纯函数用例：两种模式只差「一轮即退」与「保持到退出指令」那一句，
 * 其余（唤醒词、不反问、无关对话不调工具、指回设置页）两边都必须一致。
 * 走真 HTTP 的 initialize 覆盖在 `__tests__/mcp-http-flow.test.ts`，这里不重复建库。
 */

const COMMON = [MCP_WAKE_WORD, 'Jarvis Workbench', '不要反问', '设置 → MCP 设置'];

describe('MCP instructions 的贾维斯唤醒口径', () => {
  it('两种模式共有的口径都在，且缺省模式与 20.9 一致', () => {
    expect(DEFAULT_SETTINGS.mcp_wake_mode).toBe('single');
    for (const mode of ['single', 'continuous'] as const) {
      const text = buildMcpInstructions(mode);
      for (const phrase of COMMON) expect(text, mode).toContain(phrase);
      // 唤醒示例是给用户看的原话，客户端照它匹配，措辞不能被改动漂移掉。
      expect(text, mode).toContain(`${MCP_WAKE_WORD}，创建一个任务`);
    }
  });

  it('single：本轮完成即退出，不含退出指令措辞', () => {
    const text = buildMcpInstructions('single');
    expect(text).toContain('单次模式');
    expect(text).toContain('本轮唤醒对应的操作完成后即退出工作模式');
    expect(text).not.toContain('连续模式');
    expect(text).not.toContain(MCP_WAKE_EXIT);
  });

  it('continuous：保持到「退出贾维斯」，并写明退出时确认一次', () => {
    const text = buildMcpInstructions('continuous');
    expect(text).toContain('连续模式');
    expect(text).toContain(MCP_WAKE_EXIT);
    expect(text).toContain('简短确认一次');
    expect(text).not.toContain('单次模式');
  });

  it('整段控制在客户端惯例长度内（会整段注入上下文）', () => {
    for (const mode of ['single', 'continuous'] as const) {
      expect(buildMcpInstructions(mode).length).toBeLessThan(1000);
    }
  });
});

describe('wakeModeNotice 的模式随行文案', () => {
  it('single：含「单次」与一轮即退口径，不含连续措辞', () => {
    const text = wakeModeNotice('single');
    expect(text).toContain(`【${MCP_WAKE_WORD}】当前会话模式：单次`);
    expect(text).toContain('本轮唤醒对应的操作完成后即退出工作模式');
    expect(text).not.toContain('连续');
  });

  it('continuous：含「连续」与退出指令措辞，不含单次口径', () => {
    const text = wakeModeNotice('continuous');
    expect(text).toContain(`【${MCP_WAKE_WORD}】当前会话模式：连续`);
    expect(text).toContain(MCP_WAKE_EXIT);
    expect(text).not.toContain('单次');
  });
});
