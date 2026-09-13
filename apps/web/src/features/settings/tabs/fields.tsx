import { useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button, Dialog, IconButton, Input, Select, Switch, Tooltip } from '@/components/ui';
import { contextNumber, errorMessage, isApiError } from '@/api';
import type { FieldDef, FieldDefCreateInput, FieldDefPatchInput, FieldType } from '@/api/types';
import { FIELD_TYPE_LABEL, PHASE_ONE_FIELD_TYPES } from '@/lib/labels';
import { ChipEditor } from '../components/chip-editor';
import { ConfirmDialog } from '../components/confirm-dialog';
import {
  FormError,
  RowActions,
  SettingRow,
  SettingsTable,
  SettingSection,
  TabHeader,
} from '../components/settings-ui';
import {
  useCreateFieldDef,
  useDeleteFieldDef,
  useFieldDefs,
  usePatchFieldDef,
  useSettingsWriter,
} from '../queries';
import {
  CARD_FIELD_MAX,
  FIELD_KEY_RE,
  FIELD_LABEL_MAX,
  FIELD_OPTION_MAX,
  TASK_TYPE_LIST_MAX,
  TASK_TYPE_MAX,
  cardEligible,
  clampText,
  selectOptions,
} from '../utils';

/**
 * 字段定义 Tab（8.5 / 原型 7.4 / PRD 6.9.1）。
 *
 * 三条硬规则在界面上的落点：
 * 1. `key` 与 `type` 保存后不可改（13 章：PATCH 里出现即 422）——所以**编辑态表单里根本没有
 *    这两个输入框**，而不是给一个禁用框让人以为能改；两者以只读形式出现在弹窗顶部说明里。
 * 2. 全表最多 2 个卡片字段、且仅 `text/number/select/bool`（6.9.1）——列表里的「卡片显示」
 *    是真开关：`textarea` 行不给这个控件，槽位满时其余置灰并在 tooltip 写明原因。
 * 3. 删除仅对未被任务引用的字段成功；`409 FIELD_IN_USE` 不当错误弹，而是就地转成
 *    「改为停用？」的引导（7.4 末行：不做「看着能点、点了没反应」的置灰）。
 */

const COLS =
  'grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_72px_56px_92px_minmax(0,0.9fr)_152px]';

/** 阶段一只放五类控件（17.2）：`multiselect`/`date`/`url` 在下拉里就不出现。 */
const TYPE_OPTIONS = PHASE_ONE_FIELD_TYPES.map((type) => ({
  value: type,
  label: FIELD_TYPE_LABEL[type],
}));

export function FieldsTab() {
  const { settings } = useSettingsWriter();
  const defs = useFieldDefs();
  const create = useCreateFieldDef();
  const patch = usePatchFieldDef();
  const remove = useDeleteFieldDef();

  const taskTypes = settings?.task_types ?? [];
  const items = defs.data?.items ?? [];

  const [editing, setEditing] = useState<FieldDef | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<FieldDef | null>(null);
  /** 409 回来的字段：就地提示「改为停用」并把停用按钮标出来（7.4）。 */
  const [inUse, setInUse] = useState<{ def: FieldDef; count: number | null } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const cardCount = useMemo(() => items.filter((item) => item.show_on_card).length, [items]);

  const errorText =
    formError ??
    (create.error ? errorMessage(create.error) : patch.error ? errorMessage(patch.error) : null);

  const toggleCard = (def: FieldDef, next: boolean) => {
    setInUse(null);
    setFormError(null);
    create.reset();
    patch.reset();
    patch.mutate({ id: def.id, body: { show_on_card: next } });
  };

  const toggleEnabled = (def: FieldDef, next: boolean) => {
    setInUse(null);
    setFormError(null);
    create.reset();
    patch.reset();
    patch.mutate({ id: def.id, body: { enabled: next } });
  };

  const confirmRemove = () => {
    if (!removing) return;
    remove.mutate(removing.id, {
      onSuccess: () => setRemoving(null),
      onError: (error) => {
        if (isApiError(error) && error.code === 'FIELD_IN_USE') {
          setInUse({ def: removing, count: contextNumber(error, 'task_count') });
          setRemoving(null);
          return;
        }
        setFormError(errorMessage(error));
        setRemoving(null);
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="字段定义"
        action={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => {
              setFormError(null);
              create.reset();
              patch.reset();
              setCreating(true);
            }}
          >
            新建字段
          </Button>
        }
        description={`任务表单与筛选按这里的定义渲染；卡片最多显示 ${CARD_FIELD_MAX} 个自定义字段（6.9.2）。`}
      />

      <SettingSection bare>
        <SettingsTable
          cols={COLS}
          head={['名称', 'key', '类型', '必填', '卡片显示', '适用类型', '操作']}
          items={items}
          rowKey={(item) => item.id}
          rowTone={(item) => (item.enabled ? undefined : 'muted')}
          cells={(item) => {
            const eligible = cardEligible(item);
            const slotsTaken = cardCount >= CARD_FIELD_MAX && !item.show_on_card;
            return [
              <span key="label" className="truncate text-text-primary">
                {item.label}
              </span>,
              <span key="key" className="truncate font-mono text-code text-text-secondary">
                {item.key}
              </span>,
              <span key="type" className="text-aux text-text-secondary">
                {FIELD_TYPE_LABEL[item.type]}
              </span>,
              <span key="required" className="text-aux text-text-secondary">
                {item.required ? '是' : '否'}
              </span>,
              !eligible ? (
                <span key="card" className="text-aux text-text-tertiary">
                  —
                </span>
              ) : (
                <Tooltip
                  key="card"
                  content={
                    slotsTaken
                      ? `卡片最多显示 ${CARD_FIELD_MAX} 个自定义字段（6.9.2）`
                      : '在看板卡片上显示该字段'
                  }
                >
                  <Switch
                    checked={item.show_on_card}
                    disabled={slotsTaken}
                    onChange={(next) => toggleCard(item, next)}
                    label={`卡片显示 ${item.label}`}
                  />
                </Tooltip>
              ),
              <span key="applies" className="truncate text-aux text-text-secondary">
                {item.applies_to.length === 0 ? '全部' : item.applies_to.join('、')}
              </span>,
              <RowActions key="actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFormError(null);
                    create.reset();
                    patch.reset();
                    setEditing(item);
                  }}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant={inUse?.def.id === item.id ? 'primary' : 'ghost'}
                  onClick={() => toggleEnabled(item, !item.enabled)}
                >
                  {item.enabled ? '停用' : '启用'}
                </Button>
                <IconButton
                  label={`删除 ${item.label}`}
                  size="iconSm"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={() => {
                    setFormError(null);
                    setInUse(null);
                    remove.reset();
                    setRemoving(item);
                  }}
                />
              </RowActions>,
            ];
          }}
          empty={
            <p className="text-aux text-text-secondary">
              还没有自定义字段。新建后它会出现在任务表单与详情「概览」里。
            </p>
          }
        />
      </SettingSection>

      {inUse ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-status-running bg-status-running-soft px-4 py-3">
          <p className="text-body text-text-primary">
            该字段已被 {inUse.count ?? '若干'} 个任务使用，改为停用？
            <span className="ml-1 text-aux text-text-tertiary">
              停用后任务表单与筛选里不再出现该字段，已有值保留并继续在详情里显示（7.4）。
            </span>
          </p>
          <Button
            variant="primary"
            size="sm"
            loading={patch.isPending}
            onClick={() => toggleEnabled(inUse.def, false)}
          >
            停用「{inUse.def.label}」
          </Button>
        </div>
      ) : null}

      {inUse ? null : errorText ? <FormError>{errorText}</FormError> : null}

      {creating || editing ? (
        <FieldDefDialog
          open
          def={editing}
          taskTypes={taskTypes}
          existing={items}
          cardCount={cardCount}
          pending={create.isPending || patch.isPending}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSubmit={async ({ id, createBody, patchBody }) => {
            setFormError(null);
            try {
              if (id && patchBody) {
                await patch.mutateAsync({ id, body: patchBody });
              } else if (createBody) {
                await create.mutateAsync(createBody);
              }
              setCreating(false);
              setEditing(null);
              return;
            } catch (error) {
              setFormError(errorMessage(error));
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={`删除字段「${removing?.label ?? ''}」`}
        description="删除仅对未被任何任务引用的字段开放；被引用时接口会拒绝，并引导你改用停用。"
        detail="停用保留已存值与历史展示，删除会连带清掉这些值。"
        confirmText="删除"
        danger
        loading={remove.isPending}
        onConfirm={confirmRemove}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------- 弹窗 */

interface FieldDefSubmit {
  /** 有值即编辑：只发 `patchBody`（`createBody` 为空）。 */
  id: string | null;
  createBody?: FieldDefCreateInput;
  patchBody?: FieldDefPatchInput;
}

interface FieldDefDialogProps {
  open: boolean;
  /** null = 新建：`key` 与 `type` 两个输入框只在这种情形出现。 */
  def: FieldDef | null;
  taskTypes: readonly string[];
  existing: readonly FieldDef[];
  cardCount: number;
  pending: boolean;
  onClose: () => void;
  onSubmit: (submit: FieldDefSubmit) => Promise<void>;
}

function FieldDefDialog({
  open,
  def,
  taskTypes,
  existing,
  cardCount,
  pending,
  onClose,
  onSubmit,
}: FieldDefDialogProps) {
  const editing = def !== null;
  const [label, setLabel] = useState(def?.label ?? '');
  const [key, setKey] = useState(def?.key ?? '');
  const [type, setType] = useState<FieldType>(def?.type ?? 'text');
  const [options, setOptions] = useState<string[]>(selectOptions(def?.options));
  const [required, setRequired] = useState(def?.required ?? false);
  const [showOnCard, setShowOnCard] = useState(def?.show_on_card ?? false);
  const [appliesTo, setAppliesTo] = useState<string[]>(def?.applies_to ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** 卡片槽位：`textarea` 不给开关（6.9.1：248px 卡片上必然截断成噪声）。 */
  const cardAllowed = cardEligible({ type });
  const slotTaken = cardCount >= CARD_FIELD_MAX && !(def?.show_on_card ?? false);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    const name = label.trim();
    if (!name) next.label = '请填写字段名';
    else if (name.length > FIELD_LABEL_MAX) next.label = `字段名最多 ${FIELD_LABEL_MAX} 字`;
    if (!editing) {
      if (!FIELD_KEY_RE.test(key.trim())) {
        next.key = '小写字母开头，仅 a–z 0–9 _，2–32 位（20.1）';
      } else if (existing.some((item) => item.key === key.trim())) {
        next.key = '该 key 已存在';
      }
    }
    if (type === 'select') {
      if (options.length === 0) next.options = '单选类型至少要有 1 个选项';
      else if (options.length > 100) next.options = '单选最多 100 个选项（13 章）';
      else if (options.some((item) => !item.trim())) next.options = '选项不能为空';
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = () => {
    if (!validate()) return;
    const name = label.trim();
    const optionsForType = type === 'select' ? options.map((item) => item.trim()) : undefined;
    if (def) {
      // 只发可改的三项（+选项）：`key`/`type` 出现在 PATCH 里即 422（13 章）。
      void onSubmit({
        id: def.id,
        patchBody: {
          label: name,
          required,
          show_on_card: cardAllowed ? showOnCard : false,
          applies_to: appliesTo,
          options: optionsForType,
        },
      });
      return;
    }
    void onSubmit({
      id: null,
      createBody: {
        key: key.trim(),
        label: name,
        type,
        required,
        show_on_card: cardAllowed ? showOnCard : false,
        applies_to: appliesTo,
        options: optionsForType,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `编辑字段「${def.label}」` : '新建字段'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {editing ? (
          <p className="rounded-control bg-bg-muted px-3 py-2 text-aux text-text-secondary">
            key <span className="font-mono text-code">{def.key}</span> 与类型
            （{FIELD_TYPE_LABEL[def.type]}）保存后不可改：改 key 等于换字段，改类型会让已存值全部不符合
            20.10 的值契约，所以这两项不在表单里出现。
          </p>
        ) : null}

        <SettingRow label="字段名" required width="fluid" error={errors.label}>
          <Input
            value={label}
            maxLength={FIELD_LABEL_MAX}
            invalid={Boolean(errors.label)}
            placeholder="影响范围"
            onChange={(event) => {
              setLabel(event.target.value);
              setErrors({ ...errors, label: '' });
            }}
          />
        </SettingRow>

        {editing ? null : (
          <SettingRow
            label="字段 key"
            required
            width="fluid"
            error={errors.key}
            hint="小写字母开头，a–z0–9_，2–32 位；保存后不可改。"
          >
            <Input
              value={key}
              maxLength={32}
              invalid={Boolean(errors.key)}
              placeholder="impact_scope"
              onChange={(event) => {
                setKey(clampText(event.target.value.toLowerCase(), 32));
                setErrors({ ...errors, key: '' });
              }}
            />
          </SettingRow>
        )}

        <SettingRow
          label="类型"
          required
          width="narrow"
          hint={editing ? '编辑时禁用（同 key）。' : '阶段一只有五类控件（17.2）。'}
        >
          <Select
            value={type}
            disabled={editing}
            options={TYPE_OPTIONS}
            onChange={(event) => {
              setType(event.target.value as FieldType);
              setErrors({ ...errors, options: '' });
            }}
          />
        </SettingRow>

        {type === 'select' ? (
          <SettingRow label="选项" required width="fluid" error={errors.options}>
            <OptionList
              values={options}
              onChange={setOptions}
              onInvalid={(message) => setErrors({ ...errors, options: message })}
            />
          </SettingRow>
        ) : null}

        <SettingRow label="必填" hint="关掉只是不再强制填写，已存的值保留、表单照常渲染。">
          <div className="flex h-8 items-center">
            <Switch checked={required} onChange={setRequired} label="必填" />
          </div>
        </SettingRow>

        {cardAllowed ? (
          <SettingRow
            label="在卡片显示"
            hint={
              slotTaken
                ? `已选满 ${CARD_FIELD_MAX} 个卡片字段，请先关掉一个。`
                : '看板卡片上显示该字段的值。'
            }
          >
            <div className="flex h-8 items-center">
              <Tooltip content={`卡片最多显示 ${CARD_FIELD_MAX} 个自定义字段（6.9.2）`}>
                <Switch checked={showOnCard} disabled={slotTaken} onChange={setShowOnCard} label="在卡片显示" />
              </Tooltip>
            </div>
          </SettingRow>
        ) : (
          <SettingRow
            label="在卡片显示"
            hint="长文本在 248px 卡片上必然截断成噪声，因此该类型不提供卡片显示（6.9.1）。"
          >
            <span className="inline-flex h-8 items-center text-aux text-text-tertiary">—</span>
          </SettingRow>
        )}

        <SettingRow
          label="适用类型"
          width="fluid"
          hint={`可多选，一个都不选即对所有任务类型渲染该字段（20.1 的 applies_to 为空数组）；只能选词表里的类型（20.9）：${taskTypes.join('、') || '（词表为空）'}。`}
        >
          <ChipEditor
            values={appliesTo}
            max={TASK_TYPE_LIST_MAX}
            maxEach={TASK_TYPE_MAX}
            addLabel="添加类型"
            placeholder="任务类型"
            validate={(raw) =>
              taskTypes.includes(raw) ? null : `「${raw}」不在任务类型词表里（20.9）`
            }
            onChange={setAppliesTo}
          />
        </SettingRow>
      </div>
    </Dialog>
  );
}

/* --------------------------------------------------------- 选项行编辑 */

interface OptionListProps {
  values: string[];
  onChange: (next: string[]) => void;
  onInvalid: (message: string) => void;
}

/** 原型 7.4 的选项区：一行一项 + 右侧 `×` + 底部「+ 添加选项」。 */
function OptionList({ values, onChange, onInvalid }: OptionListProps) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (!value) {
      onInvalid('选项不能为空');
      return;
    }
    if (values.includes(value)) {
      onInvalid('已有同样的选项');
      return;
    }
    if (values.length >= 100) {
      onInvalid('单选最多 100 个选项（13 章）');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  /**
   * 就地改一行：去重口径与 `add()` 一致（比的是 trim 后的值、跳过自己那一行），
   * 否则把一行改成另一个已有值就凭空多出一对重复项，而 20.10 要求 `select` 的取值 ∈ `options[]`。
   */
  const edit = (index: number, raw: string) => {
    const next = clampText(raw, FIELD_OPTION_MAX);
    const value = next.trim();
    if (value && values.some((item, i) => i !== index && item.trim() === value)) {
      onInvalid('已有同样的选项');
      return;
    }
    const list = [...values];
    list[index] = next;
    onChange(list);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-control border border-border p-2">
      {values.map((value, index) => (
        // 键取行号而不是值：导入的文件里 `options` 可以带重复项（服务端不去重），
        // 按值取键会撞成同一个 key。行内只有受控 Input，就地改值不换键才不会丢焦点。
        <div key={index} className="flex items-center gap-2">
          <Input
            className="h-7"
            value={value}
            maxLength={FIELD_OPTION_MAX}
            onChange={(event) => edit(index, event.target.value)}
          />
          <IconButton
            label={`删除选项 ${value}`}
            size="iconSm"
            icon={<X className="size-3.5" />}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      {values.length === 0 ? (
        <p className="text-aux text-text-tertiary">还没有选项。</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          className="h-7 w-[200px]"
          value={draft}
          maxLength={FIELD_OPTION_MAX}
          placeholder="新选项"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button size="sm" variant="default" icon={<Plus className="size-3.5" />} onClick={add}>
          添加选项
        </Button>
      </div>
    </div>
  );
}
