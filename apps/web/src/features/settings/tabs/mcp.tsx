import { RadioGroup } from '@/components/ui';
import type { McpWakeMode } from '@/api/types';
import { MCP_WAKE_MODES } from '@/api/types';
import { MCP_WAKE_MODE_LABEL } from '@/lib/labels';
import { FormError, SettingRow, SettingSection, TabHeader } from '../components/settings-ui';
import { useSettingsWriter } from '../queries';

/**
 * MCP Tab（beta.6 B9：从 Token Tab 的「MCP 设置」分组拆出独立成项）。
 *
 * 改的是 MCP 侧行为（#46 唤醒模式），与 Token 的「接入凭证」是两件事：
 * Token Tab 管一次性明文，这里管长期生效的即时写入项，走 `useSettingsWriter`
 * 与其他 Tab 相同的写入通道。措辞与服务端 `buildMcpInstructions` 下发口径一致。
 */

/** #46 两档控件的副标题（短标签在 `lib/labels.ts`，此处只补一句「会怎样」）。 */
const WAKE_MODE_DESCRIPTION: Record<McpWakeMode, string> = {
  single: '唤醒一轮，操作完成即退出工作模式',
  continuous: '保持工作模式，直到说「退出贾维斯」',
};

const WAKE_MODE_OPTIONS = MCP_WAKE_MODES.map((mode) => ({
  value: mode,
  label: MCP_WAKE_MODE_LABEL[mode],
  description: WAKE_MODE_DESCRIPTION[mode],
}));

export function McpTab() {
  const wake = useSettingsWriter();

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="MCP 设置"
        description="对已接入本 MCP 的 Agent 说「贾维斯，创建一个任务：明天发布」，它就直接用看板工具完成请求，不反问是否使用工具。"
      />

      <SettingSection title="工作模式">
        <SettingRow
          label="唤醒后的会话模式"
          width="fluid"
          hint="连续模式下唤醒后一直保持，说「退出贾维斯」才退出；与唤醒无关的普通对话不会触发看板工具。每次工具调用返回都会附带最新的「【贾维斯】当前会话模式」行，切换后下一次工具调用即生效，无需重连 MCP 客户端。"
        >
          <RadioGroup
            layout="column"
            value={wake.settings?.mcp_wake_mode ?? 'single'}
            options={WAKE_MODE_OPTIONS}
            onChange={(value) => wake.set('mcp_wake_mode', value as McpWakeMode)}
          />
        </SettingRow>
        {wake.errorText ? <FormError>{wake.errorText}</FormError> : null}
      </SettingSection>
    </div>
  );
}
