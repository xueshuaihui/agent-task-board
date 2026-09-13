import { useState } from 'react';
import { RadioGroup, Select, Switch } from '@/components/ui';
import type { Settings } from '@/api/types';
import { ChipEditor } from '../components/chip-editor';
import { ConfirmDialog } from '../components/confirm-dialog';
import { FormError, SettingRow, SettingSection, TabHeader } from '../components/settings-ui';
import { countTasksByType, useSettingsWriter } from '../queries';
import { optionsWithCurrent, TASK_TYPE_LIST_MAX, TASK_TYPE_MAX } from '../utils';

/**
 * 通用 Tab（8.5 / 原型 7.2）：七个键，全部即时 `PATCH /settings`，**没有「保存」按钮**。
 *
 * 档位取自 20.9 的区间，但只显示常用的几档；库里存着档位外的值时
 * `optionsWithCurrent` 会把它补进候选，select 不会把一个合法值显示成别的数字。
 */

const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
] as const;

const ARTIFACT_MB = [5, 10, 20, 50, 100] as const;
const BOARD_LIMIT = [20, 50, 100, 200] as const;
const LEASE_MINUTES = [5, 10, 15, 30, 60, 120] as const;
const HEARTBEAT_SECONDS = [60, 120, 300, 600] as const;

export function GeneralTab() {
  const { settings, set, patch, errorText } = useSettingsWriter();

  // 存值怎么落到 DOM 上是壳层的事（`app/app.tsx` 的 `useUiThemeSync`）：
  // 这里写成功后 `useSettingsWriter` 更新的是同一份 `qk.settings()` 缓存，主题随即跟上，
  // 不必在本页再调一次 `applyUiTheme`——别的路径（导入、另一个窗口）改的值也归壳层管。

  const [pendingType, setPendingType] = useState<{ name: string; used: number | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const taskTypes = settings?.task_types ?? [];

  const requestRemoveType = async (name: string) => {
    setBusy(true);
    const used = await countTasksByType(name);
    setBusy(false);
    setPendingType({ name, used });
  };

  const confirmRemoveType = () => {
    const target = pendingType?.name;
    setPendingType(null);
    if (!target) return;
    patch({ task_types: taskTypes.filter((item) => item !== target) });
  };

  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="通用" />

      <SettingSection>
        <SettingRow
          label="界面主题"
          hint="深色一套色板阶段一未定义（原型 v1.1 只给浅色），选「深色」会存下值但界面仍是浅色。"
        >
          <div className="flex h-8 items-center">
            <RadioGroup
              value={settings?.ui_theme ?? 'system'}
              options={THEME_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={(value) => set('ui_theme', value as Settings['ui_theme'])}
            />
          </div>
        </SettingRow>

        <SettingRow
          label="任务类型词表"
          width="fluid"
          required
          hint={`单个 ≤ ${TASK_TYPE_MAX} 字，最多 ${TASK_TYPE_LIST_MAX} 个；改动只作用于此后新建的任务下拉与看板筛选。`}
        >
          <ChipEditor
            values={taskTypes}
            max={TASK_TYPE_LIST_MAX}
            maxEach={TASK_TYPE_MAX}
            addLabel="添加类型"
            placeholder="新类型名"
            guardRemove={(value) =>
              taskTypes.length <= 1 ? `至少保留 1 个任务类型（20.9）：当前只剩「${value}」` : null
            }
            onRemoveRequest={(value) => void requestRemoveType(value)}
            onChange={(next) => patch({ task_types: next })}
          />
        </SettingRow>

        <SettingRow
          label="审核意见"
          hint="打开后审核表单预填上一次填写的意见；关掉则每次从空表单开始。"
        >
          <div className="flex h-8 items-center gap-2">
            <Switch
              checked={settings?.review_reuse_last_opinion ?? true}
              onChange={(checked) => set('review_reuse_last_opinion', checked)}
              label="审核意见预填上一次填写的意见"
            />
            <span className="text-aux text-text-tertiary">预填上一次填写的意见</span>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title="容量与轮询">
        <SettingRow
          label="产物单文件上限"
          hint="超过后 Agent 上传被拒（413 ARTIFACT_TOO_LARGE）。"
          width="narrow"
        >
          <Select
            value={String(settings?.artifact_max_mb ?? 20)}
            options={optionsWithCurrent(ARTIFACT_MB, settings?.artifact_max_mb ?? 20, (v) => `${v} MB`)}
            onChange={(event) => set('artifact_max_mb', Number(event.target.value))}
          />
        </SettingRow>

        <SettingRow
          label="看板每列渲染上限"
          hint="超出部分经「任务」列表页分页查看；列头仍显示真实计数。"
          width="narrow"
        >
          <Select
            value={String(settings?.board_column_limit ?? 50)}
            options={optionsWithCurrent(
              BOARD_LIMIT,
              settings?.board_column_limit ?? 50,
              (v) => `${v} 张`,
            )}
            onChange={(event) => set('board_column_limit', Number(event.target.value))}
          />
        </SettingRow>

        <SettingRow
          label="认领租约时长"
          hint="仅影响此后新认领的任务：已发出的租约按各自 `lease_expires_at` 倒计时。"
          width="narrow"
        >
          <Select
            value={String(settings?.lease_ttl_minutes ?? 30)}
            options={optionsWithCurrent(
              LEASE_MINUTES,
              settings?.lease_ttl_minutes ?? 30,
              (v) => `${v} 分钟`,
            )}
            onChange={(event) => set('lease_ttl_minutes', Number(event.target.value))}
          />
        </SettingRow>

        <SettingRow
          label="建议轮询周期"
          hint="提示值，服务端不强制：Agent 侧 MCP 客户端读它决定 `claim_next_task` 间隔。"
          width="narrow"
        >
          <Select
            value={String(settings?.heartbeat_interval_seconds ?? 300)}
            options={optionsWithCurrent(
              HEARTBEAT_SECONDS,
              settings?.heartbeat_interval_seconds ?? 300,
              (v) => `${v} 秒`,
            )}
            onChange={(event) => set('heartbeat_interval_seconds', Number(event.target.value))}
          />
        </SettingRow>
      </SettingSection>

      {errorText ? <FormError>{errorText}</FormError> : null}

      <ConfirmDialog
        open={pendingType !== null}
        title={`删除任务类型「${pendingType?.name ?? ''}」`}
        description={
          pendingType?.used
            ? `删除后不影响 ${pendingType.used} 个已有任务，它们仍显示为「${pendingType.name}」。`
            : '删除后已有任务的类型原样保留并继续显示（20.3），只影响此后新建任务的下拉候选。'
        }
        detail="该类型不会再出现在新建任务与筛选面板里；已归档任务同样不受影响。"
        confirmText="删除"
        danger
        loading={busy}
        onConfirm={confirmRemoveType}
        onClose={() => setPendingType(null)}
      />
    </div>
  );
}
