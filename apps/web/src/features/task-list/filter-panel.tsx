import { useMemo, useState, type ReactNode } from 'react';
import { Check, Search, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useFieldDefs, useSettings, useTags } from '@/api';
import { TASK_STATUSES, type ArchivedFilter, type FieldDef, type TaskStatus } from '@/api/types';
import { activeFilterCount, useFilterStore } from '@/app/store/filters';
import { transitions } from '@/lib/motion';
import { Badge, Button, Checkbox, Input, Menu, MenuCaret, RadioGroup } from '@/components/ui';
import type { MenuItem } from '@/components/ui';
import { cn } from '@/lib/cn';
import { PHASE_ONE_FIELD_TYPES, PRIORITY_LABEL, STATUS_LABEL, labelOf } from '@/lib/labels';

/**
 * 3.5 筛选面板 + 3.4 的 chip 快捷入口。**两者读写同一份 `useFilterStore`**（原型 3.5
 * 「chip 是面板里对应分组的快捷入口，两者读写同一份筛选状态」），所以没有草稿态：
 * 面板底部的按钮只报「已生效 N 项」并收起面板，不扮演「应用筛选」——
 * 有草稿就有两份真值，正是原型 3.5 反复强调要避免的那件事。
 *
 * 与看板面板的差别（原型 3.5 末行）：列表页**多**一个「状态」分组（board 用六列表达状态），
 * 另外按交付范围把「自定义字段」分组也做了——原型 3.5 / PRD 17.2 把它排到阶段二，
 * 但 `custom_fields[key]` 的服务端契约阶段一已就位（`listQuerySchema`），UI 补上不改接口。
 */

const PRIORITIES = [0, 1, 2, 3] as const;

/* ------------------------------------------------------------------ chips */

export function FilterChips({
  panelOpen,
  onTogglePanel,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const filters = useFilterStore();
  const settings = useSettings();
  const tags = useTags();
  const types = settings.data?.task_types ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MultiSelectChip
        label="状态"
        selected={filters.status}
        options={TASK_STATUSES.map((status) => ({
          value: status,
          label: STATUS_LABEL[status],
        }))}
        onToggle={(value) => filters.toggleString('status', value)}
      />
      <MultiSelectChip
        label="优先级"
        selected={filters.priority.map(String)}
        options={PRIORITIES.map((priority) => ({
          value: String(priority),
          label: `P${priority} ${PRIORITY_LABEL[priority]}`,
        }))}
        onToggle={(value) => filters.toggleNumber('priority', Number(value))}
      />
      <MultiSelectChip
        label="标签"
        selected={filters.tags}
        options={(tags.data?.tags ?? []).map((tag) => ({ value: tag, label: tag }))}
        onToggle={(value) => filters.toggleString('tags', value)}
      />
      <MultiSelectChip
        label="类型"
        selected={filters.type}
        options={types.map((type) => ({ value: type, label: type }))}
        onToggle={(value) => filters.toggleString('type', value)}
      />
      <Button
        size="sm"
        aria-expanded={panelOpen}
        onClick={onTogglePanel}
        className={cn(
          panelOpen || Object.keys(filters.customFields).length > 0
            ? 'border-primary text-text-primary'
            : 'text-text-secondary',
        )}
      >
        更多
        <MenuCaret open={panelOpen} />
      </Button>
    </div>
  );
}

function MultiSelectChip({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  const items: MenuItem[] = options.map((option) => ({
    id: option.value,
    label: option.label,
    icon: selected.includes(option.value) ? (
      <Check className="size-3.5 text-primary" aria-hidden />
    ) : null,
    onSelect: () => onToggle(option.value),
  }));
  return (
    <Menu
      width={220}
      groups={[{ items }]}
      trigger={({ open, toggle }) => (
        <Button
          size="sm"
          aria-expanded={open}
          onClick={toggle}
          className={cn(selected.length > 0 ? 'border-primary text-text-primary' : 'text-text-secondary')}
        >
          {label}
          {selected.length > 0 ? (
            <span className="rounded-badge bg-primary-light px-1 text-badge text-primary">
              {selected.length}
            </span>
          ) : null}
          <MenuCaret open={open} />
        </Button>
      )}
    />
  );
}

/* ------------------------------------------------------------------ 面板 */

export function FilterPanel({ onClose }: { onClose: () => void }) {
  const filters = useFilterStore();
  const settings = useSettings();
  const fieldDefs = useFieldDefs();
  const count = activeFilterCount(filters);
  const reducedMotion = useReducedMotion();

  const visibleFields = useMemo(
    () =>
      (fieldDefs.data?.items ?? [])
        .filter((def) => def.enabled && PHASE_ONE_FIELD_TYPES.includes(def.type))
        .sort((a, b) => a.sort_order - b.sort_order),
    [fieldDefs.data],
  );

  return (
    <motion.div
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : transitions.overlay}
      className="rounded-card border border-border bg-bg-surface shadow-pop"
    >
      <div className="atb-scroll flex max-h-[360px] flex-col gap-3 overflow-y-auto p-4">
        <Group label="状态">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {TASK_STATUSES.map((status) => (
              <Checkbox
                key={status}
                label={STATUS_LABEL[status]}
                checked={filters.status.includes(status)}
                onChange={() => filters.toggleString('status', status)}
              />
            ))}
          </div>
        </Group>

        <Group label="优先级">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PRIORITIES.map((priority) => (
              <Checkbox
                key={priority}
                label={`P${priority} ${PRIORITY_LABEL[priority]}`}
                checked={filters.priority.includes(priority)}
                onChange={() => filters.toggleNumber('priority', priority)}
              />
            ))}
          </div>
        </Group>

        <Group label="类型">
          <div className="flex flex-wrap gap-1.5">
            {(settings.data?.task_types ?? []).map((type) => (
              <ToggleChip
                key={type}
                value={type}
                active={filters.type.includes(type)}
                onToggle={() => filters.toggleString('type', type)}
              />
            ))}
            {(settings.data?.task_types ?? []).length === 0 ? (
              <Empty text="没有可选类型" />
            ) : null}
          </div>
        </Group>

        <TagGroup />

        <Group label="自定义字段">
          {visibleFields.length === 0 ? (
            <Empty text="还没有启用中的字段定义（设置页「字段定义」里建）" />
          ) : (
            <div className="flex flex-col gap-2">
              {visibleFields.map((def) => (
                <CustomFieldRow
                  key={def.id}
                  def={def}
                  values={filters.customFields[def.key] ?? []}
                  onChange={(next) => filters.setCustomField(def.key, next)}
                />
              ))}
            </div>
          )}
        </Group>

        <Group label="归档">
          <RadioGroup
            value={filters.archived}
            options={ARCHIVED_OPTIONS}
            onChange={(value) => filters.setArchived(value as ArchivedFilter)}
          />
          <p className="text-aux text-text-tertiary">
            归档任务不在看板出现（20.7），只在本页用{' '}
            <code className="font-mono" data-selectable>
              archived
            </code>{' '}
            三态读（6.13.1）。
          </p>
        </Group>

        <Group label="依赖状态 / 时间范围">
          <Empty text="列表接口没有这两组参数（20.3）：依赖状态走看板视图预设，时间范围阶段一不做。" />
        </Group>
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-aux text-text-secondary">
          {count > 0 ? `已生效 ${count} 项条件` : '没有筛选条件'}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => filters.reset()}>
            重置
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      </footer>
    </motion.div>
  );
}

function TagGroup() {
  const filters = useFilterStore();
  const tags = useTags();
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => {
    const known = tags.data?.tags ?? [];
    const needle = query.trim().toLowerCase();
    const pool = needle ? known.filter((tag) => tag.toLowerCase().startsWith(needle)) : known;
    return pool.filter((tag) => !filters.tags.includes(tag)).slice(0, 12);
  }, [tags.data, query, filters.tags]);

  return (
    <Group label="标签">
      <div className="flex flex-wrap gap-1.5">
        {filters.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            aria-label={`移除标签 ${tag}`}
            className="inline-flex items-center gap-1 rounded-tag bg-primary-light px-1.5 py-px text-badge text-primary"
            onClick={() => filters.toggleString('tags', tag)}
          >
            {tag}
            <X className="size-3" aria-hidden />
          </button>
        ))}
        {filters.tags.length === 0 ? <Empty text="未选标签" /> : null}
      </div>
      <div className="relative mt-1 w-[220px]">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" />
        <Input
          aria-label="搜索标签候选"
          className="pl-7"
          value={query}
          placeholder="从已有标签里找"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {candidates.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((tag) => (
            <button
              key={tag}
              type="button"
              className="rounded-tag border border-border px-1.5 py-px text-badge text-text-secondary hover:border-primary hover:text-primary"
              onClick={() => filters.toggleString('tags', tag)}
            >
              + {tag}
            </button>
          ))}
        </div>
      ) : null}
    </Group>
  );
}

/** 20.10 + 17.2：阶段一给 `text`/`textarea`/`number`/`select`/`bool` 五类控件。 */
function CustomFieldRow({
  def,
  values,
  onChange,
}: {
  def: FieldDef;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const single = def.type === 'text' || def.type === 'textarea' || def.type === 'number';
  const options = Array.isArray(def.options) ? def.options : [];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[120px] shrink-0 truncate text-aux text-text-secondary" title={def.label}>
        {def.label}
        <span className="ml-1 text-text-tertiary">{labelOfType(def)}</span>
      </span>
      {single ? (
        <div className="w-[180px]">
          <Input
            aria-label={def.label}
            type={def.type === 'number' ? 'number' : 'text'}
            value={values[0] ?? ''}
            placeholder={def.required ? '必填' : '精确匹配取值'}
            onChange={(event) => {
              const value = event.target.value.trim();
              onChange(value ? [value] : []);
            }}
          />
        </div>
      ) : def.type === 'bool' ? (
        <RadioGroup
          value={values[0] ?? ''}
          options={BOOL_OPTIONS}
          onChange={(value) => onChange(value ? [value] : [])}
        />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <ToggleChip
              key={option}
              value={option}
              active={values.includes(option)}
              onToggle={() =>
                onChange(
                  values.includes(option)
                    ? values.filter((item) => item !== option)
                    : [...values, option],
                )
              }
            />
          ))}
          {options.length === 0 ? <Empty text="该字段没有候选值" /> : null}
        </div>
      )}
    </div>
  );
}

function ToggleChip({
  value,
  active,
  onToggle,
}: {
  value: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'inline-flex items-center gap-1 rounded-tag border px-1.5 py-px text-badge transition-colors duration-120 ease-out',
        active
          ? 'border-primary bg-primary-light text-primary'
          : 'border-border text-text-secondary hover:text-text-primary',
      )}
    >
      {active ? <Check className="size-3" aria-hidden /> : null}
      {value}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 sm:flex-row sm:gap-3">
      <h4 className="w-[104px] shrink-0 text-aux text-text-secondary">{label}</h4>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <span className="text-aux text-text-tertiary">{text}</span>;
}

const ARCHIVED_OPTIONS: readonly { value: string; label: ReactNode }[] = [
  { value: 'false', label: '不含已归档' },
  { value: 'all', label: '包含已归档' },
  { value: 'true', label: '只看已归档' },
];

const BOOL_OPTIONS: readonly { value: string; label: ReactNode }[] = [
  { value: '', label: '不限' },
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
];

/** 20.2 末段口径：类型词表演进时原样透传，这里只补一个中文名提示。 */
function labelOfType(def: FieldDef): string {
  return labelOf(PHASE_ONE_FIELD_TYPE_LABELS, def.type);
}

const PHASE_ONE_FIELD_TYPE_LABELS: Partial<Record<FieldDef['type'], string>> = {
  text: '文本',
  textarea: '多行',
  number: '数字',
  select: '单选',
  bool: '是否',
};

/** 面板外部的「已选条件」摘要（原型 3.4 的「已筛 2 项 ✕ 清除全部」）。 */
export function ActiveFilterSummary() {
  const filters = useFilterStore();
  const count = activeFilterCount(filters);
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-aux text-text-secondary">
      <Badge tone="neutral">已筛 {count} 项</Badge>
      {filters.status.map((status: TaskStatus) => (
        <button
          key={status}
          type="button"
          className="inline-flex items-center gap-1 rounded-tag border border-border px-1.5 py-px text-badge hover:border-primary"
          onClick={() => filters.toggleString('status', status)}
        >
          状态：{STATUS_LABEL[status]}
          <X className="size-3" aria-hidden />
        </button>
      ))}
      <button
        type="button"
        className="text-primary hover:text-primary-hover"
        onClick={() => filters.reset()}
      >
        ✕ 清除全部
      </button>
    </div>
  );
}
