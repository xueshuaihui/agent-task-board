import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, RadioGroup, Select } from '@/components/ui';
import { GROUPABLE_KEYS, GROUP_DIMENSIONS, type GroupDimensionKey } from './dimensions';
import { useGroupingStore, type GroupingPrefs } from './useGroupingState';

/**
 * 4.6 分组选择器：主分组（单选）+ 次分组（下拉）+ 分组选项，点「应用」才提交
 * （编辑期间用本地草稿态，取消不落盘）。
 */
export interface GroupSelectorProps {
  open: boolean;
  onClose: () => void;
}

const NONE = 'none';

type Draft = Pick<GroupingPrefs, 'primary' | 'secondary' | 'options'>;

export function GroupSelector({ open, onClose }: GroupSelectorProps) {
  const current = useGroupingStore((state) => ({
    primary: state.primary,
    secondary: state.secondary,
    options: state.options,
  }));
  const update = useGroupingStore((state) => state.update);
  const [draft, setDraft] = useState<Draft>(current);

  useEffect(() => {
    // 只在打开瞬间拉当前值做草稿；此后 prefs 变化不回写（应用前不被覆盖）。
    if (open) setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const secondaryOptions = [
    { value: NONE, label: '无' },
    ...GROUPABLE_KEYS.filter((key) => key !== draft.primary).map((key) => ({
      value: key,
      label: GROUP_DIMENSIONS[key].label,
    })),
  ];

  const apply = () => {
    const secondary = draft.secondary !== NONE && draft.secondary !== draft.primary ? draft.secondary : NONE;
    update({ primary: draft.primary, secondary, options: draft.options });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="分组" size="form">
      <div className="flex flex-col gap-5">
        <section>
          <h4 className="mb-2 text-nav text-text-secondary">主分组</h4>
          <RadioGroup
            layout="column"
            name="grouping-primary"
            value={draft.primary}
            onChange={(value) => setDraft((prev) => ({ ...prev, primary: value as GroupDimensionKey }))}
            options={[
              ...GROUPABLE_KEYS.map((key) => ({ value: key, label: GROUP_DIMENSIONS[key].label })),
              { value: NONE, label: '不分组' },
            ]}
          />
        </section>

        <section>
          <h4 className="mb-2 text-nav text-text-secondary">次分组</h4>
          <Select
            className="w-56"
            value={draft.secondary}
            onChange={(event) => setDraft((prev) => ({ ...prev, secondary: event.target.value as GroupDimensionKey }))}
            options={secondaryOptions}
          />
        </section>

        <section>
          <h4 className="mb-2 text-nav text-text-secondary">分组选项</h4>
          <div className="flex flex-col gap-2">
            {(
              [
                ['showEmptyLanes', '显示空分组'],
                ['collapsible', '分组可折叠'],
                ['showStats', '显示分组统计'],
                ['rememberOrder', '记住分组顺序'],
              ] as const
            ).map(([key, label]) => (
              <Checkbox
                key={key}
                label={label}
                checked={draft.options[key]}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, options: { ...prev.options, [key]: event.target.checked } }))
                }
              />
            ))}
          </div>
        </section>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" onClick={apply}>
          应用
        </Button>
      </div>
    </Dialog>
  );
}
