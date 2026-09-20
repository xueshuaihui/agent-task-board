import { RotateCcw } from 'lucide-react';
import { Button, Select, Switch } from '@/components/ui';
import { clearFlowLayout, DEFAULT_VIEW_PREFS, useViewPrefsStore } from '../../board/flow/view-prefs';
import { SettingRow, SettingSection, TabHeader } from '../components/settings-ui';

/**
 * 设置 / 视图 Tab（v0.0.4 §6.4.9，W5）：流程图/看板共用的视图参数。
 *
 * 全部落在 prefs 键 `board.view`（存量 GET/PUT /prefs/:key，不新增后端接口）；
 * 与流程图工具栏读写同一份 `useViewPrefsStore`，**改一处即时生效**，无需保存按钮。
 * 布局坐标是独立键 `board.flow.layout`（§6.4.9「布局是否持久化」的开关只管写不写它）。
 * 档位边界/阈值都是数字，控件给常用档位 + 由 `normalizeViewPrefs` 兜住非法值。
 */

const NUM_OPTIONS = (values: readonly number[], format: (v: number) => string) =>
  values.map((value) => ({ value: String(value), label: format(value) }));

const PERF_SMALL = [20, 50, 100] as const;
const PERF_LARGE = [100, 200, 500] as const;
const SIMPLIFY = [50, 100, 150, 200] as const;
const ZOOM_MIN = [25, 50, 75] as const;
const ZOOM_MAX = [150, 200, 300, 400] as const;

export function ViewTab() {
  const prefs = useViewPrefsStore();
  const update = useViewPrefsStore((state) => state.update);
  const reset = useViewPrefsStore((state) => state.reset);

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="视图"
        description="看板 / 流程图的显示参数（§6.4.9）。改动即时生效并记忆到本机偏好（prefs / board.view），刷新与重启后保留。"
        action={
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw className="size-3.5" aria-hidden />}
            onClick={() => {
              reset();
              clearFlowLayout();
            }}
          >
            恢复默认
          </Button>
        }
      />

      <SettingSection title="流程图" description="节点规格与连线样式是设计稿口径（§6.4.3/6.4.4），这里只放性能与默认交互。">
        <SettingRow
          label="默认方向"
          hint="新建布局的流向；画布工具栏的方向选择改的是同一偏好。"
          width="narrow"
          htmlFor="view-direction"
        >
          <Select
            id="view-direction"
            value={prefs.flowDirection}
            options={[
              { value: 'TB', label: '从上到下 ↓' },
              { value: 'LR', label: '从左到右 →' },
            ]}
            onChange={(event) => update({ flowDirection: event.target.value === 'LR' ? 'LR' : 'TB' })}
          />
        </SettingRow>

        <SettingRow label="节点简化阈值" width="narrow" htmlFor="view-simplify">
          <Select
            id="view-simplify"
            value={String(prefs.simplifyThreshold)}
            options={NUM_OPTIONS(SIMPLIFY, (v) => `${v} 个节点`)}
            onChange={(event) => update({ simplifyThreshold: Number(event.target.value) })}
          />
        </SettingRow>

        <SettingRow
          label="性能档位边界"
          hint={`< ${prefs.perfSmallLimit} 全渲染；${prefs.perfSmallLimit}–${prefs.perfLargeLimit} 虚拟化；> ${prefs.perfLargeLimit} 提示筛选。`}
          width="control"
        >
          <div className="flex items-center gap-2">
            <Select
              aria-label="小档边界"
              value={String(prefs.perfSmallLimit)}
              options={NUM_OPTIONS(PERF_SMALL, (v) => `下界 ${v}`)}
              onChange={(event) => update({ perfSmallLimit: Number(event.target.value) })}
            />
            <span className="text-aux text-text-tertiary">/</span>
            <Select
              aria-label="大档边界"
              value={String(prefs.perfLargeLimit)}
              options={NUM_OPTIONS(PERF_LARGE, (v) => `上界 ${v}`)}
              onChange={(event) => update({ perfLargeLimit: Number(event.target.value) })}
            />
          </div>
        </SettingRow>

        <SettingRow label="缩放范围" hint="滚轮 / 按钮缩放的上下限（§6.4.8 默认 50%–200%）。" width="control">
          <div className="flex items-center gap-2">
            <Select
              aria-label="最小缩放"
              value={String(prefs.zoomMinPercent)}
              options={NUM_OPTIONS(ZOOM_MIN, (v) => `${v}%`)}
              onChange={(event) => update({ zoomMinPercent: Number(event.target.value) })}
            />
            <span className="text-aux text-text-tertiary">–</span>
            <Select
              aria-label="最大缩放"
              value={String(prefs.zoomMaxPercent)}
              options={NUM_OPTIONS(ZOOM_MAX, (v) => `${v}%`)}
              onChange={(event) => update({ zoomMaxPercent: Number(event.target.value) })}
            />
          </div>
        </SettingRow>

        <SettingRow label="高亮关键路径" hint="默认开关；画布工具栏可临时拨动并写回这里。">
          <div className="flex h-8 items-center gap-2">
            <Switch
              checked={prefs.highlightCritical}
              onChange={(checked) => update({ highlightCritical: checked })}
              label="默认高亮关键路径"
            />
            <span className="text-aux text-text-tertiary">最长依赖链橙色加粗</span>
          </div>
        </SettingRow>

        <SettingRow label="高亮阻塞链" hint="默认开关；被阻塞任务及其上游红色标记。">
          <div className="flex h-8 items-center gap-2">
            <Switch
              checked={prefs.highlightBlocked}
              onChange={(checked) => update({ highlightBlocked: checked })}
              label="默认高亮阻塞链"
            />
            <span className="text-aux text-text-tertiary">阻塞任务及上游红色</span>
          </div>
        </SettingRow>

        <SettingRow
          label="布局持久化"
          hint={`关闭后拖拽位置只留在本次会话；重开或点「重排布局」回到分层算法。默认键 board.flow.layout。`}
        >
          <div className="flex h-8 items-center gap-2">
            <Switch
              checked={prefs.persistLayout}
              onChange={(checked) => update({ persistLayout: checked })}
              label="记住拖拽后的节点位置"
            />
            <span className="text-aux text-text-tertiary">记住拖拽后的节点位置</span>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection title="看板" description="§6.4.9：看板侧保留「视图选择记忆到用户偏好」——三视图段控件（看板/流程图）的选择即时写入同一偏好。">
        <SettingRow label="记住视图选择" hint="下次启动看板页时恢复上次停留的视图（列表为独立页，跳转不落偏好）。">
          <div className="flex h-8 items-center">
            <span className="text-aux text-text-tertiary">
              当前记忆：{prefs.mode === 'flow' ? '流程图' : '看板'} · 默认：{DEFAULT_VIEW_PREFS.mode === 'flow' ? '流程图' : '看板'}
            </span>
          </div>
        </SettingRow>
      </SettingSection>
    </div>
  );
}
