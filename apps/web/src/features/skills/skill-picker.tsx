import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, Input, Popover } from '@/components/ui';
import { searchSkills } from './skill-search';
import { SKILL_TYPE_META } from './meta';
import type { Skill } from './types';
import {
  DEFAULT_PICKER_LIMIT,
  buildFlatPlan,
  buildGroupPlan,
  duplicateNameSet,
  pickerRowNameSegments,
  type PickerFlatPlan,
  type PickerGroupPlan,
  type PickerRowPlan,
} from './skill-picker-core';

/**
 * D-2 共享 SkillPicker：三处「选技能」（任务详情绑定、拆解草案多选、子技能引用）
 * 的统一标准面板。匹配层直接吃 D-1 的 searchSkills——每次按键本地全量重算、零请求。
 *
 * 行为口径（裁定于 D-2 任务书，勿在此之外的地方另写一套）：
 * - 空查询按分类分组平铺（组头 `分类（条数）`、未分类恒最后、组内名称稳定序），
 *   有查询按 score 序平铺 + 命中数弱提示；截断默认 20 条，尾提示「细化查询」。
 * - 行内容一套标准：消歧名 + D-1 matches 高亮 + 分类/类型/版本/状态；业务动作
 *   只经 trailing 插槽注入，组件本身不发请求、不做业务过滤（排除已选/归档归调用方）。
 *   C-6b② 起行内名称优先；C-6c 收口窗口化门控与预算来源：仅当名称字段确有命中时
 *   才按命中位置开窗（零命中/分组态恒全名直出），预算由每行名称盒的实测像素宽换算
 *   （显示宽度单位，见 skill-picker-core 的 pickerRowNameSegments）；消歧后缀渲染在
 *   truncate 盒之外恒可见。查询态留名称+类型徽标+版本，分类文本仅命中在分类上时出现；
 *   状态徽标两态都撤。
 * - 挂载两形态：SkillPicker（内联面板）与 SkillPickerPopover（带触发器弹层），
 *   共用同一份面板实现；键盘 ↑↓/Enter 在输入框上完成，Esc 不拦截、交给弹层关闭。
 *
 * 可测部分全部抽在 skill-picker-core.ts（纯函数 + 单测），本文件只留渲染接线。
 */

export * from './skill-picker-core';

export interface SkillPickerProps {
  /** 候选技能（调用方过滤后传入：排除已绑定/ARCHIVED 等都留在外面）。 */
  candidates: readonly Skill[];
  /** 选中回调：单选 = 确认选择，多选 = 对这一项做增/删（语义由调用方定）。 */
  onSelect: (skill: Skill) => void;
  /** 多选：行尾显示勾选列、选中后面板保持打开（弹层形态不关闭）。 */
  multiple?: boolean;
  /** 已选 id 集合：多选渲染勾选态；单选弹层也可用于回显高亮。 */
  selectedIds?: readonly string[];
  /** 受控查询词（可选）：不传则组件内部持有；配合 onQueryChange 可做深链回显。 */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** 查询态平铺上限，默认 DEFAULT_PICKER_LIMIT（20）。 */
  limit?: number;
  /** 重名判定的统计作用域（默认 = candidates）：breakdown 传全量表，保证过滤前后消歧口径一致。 */
  disambiguateOver?: readonly Skill[];
  /** 行尾业务插槽（如「绑定」按钮）：点击不触发行选中，由组件 stopPropagation 兜底。 */
  trailing?: (skill: Skill) => ReactNode;
  /** 搜索框占位文案。 */
  placeholder?: string;
  /** 无任何候选时的提示（区别于「无匹配」）。 */
  emptyText?: string;
  disabled?: boolean;
  /** 搜索框与 listbox 的无障碍名。 */
  ariaLabel?: string;
  className?: string;
  /** 搜索框追加样式（如子技能块的 h-7 紧凑档）。 */
  inputClassName?: string;
  /**
   * C-6b③/C-6c④：挂载时聚焦搜索框（如「复制技能」弹窗——搜索是唯一主操作，打开即该能
   * 打字）。默认 false = 行为与 C-6b 之前完全一致；弹层形态本就打开即聚焦，无需此开关。
   * 实现为挂载后的显式 focus（不是 React 原生 autoFocus——真机实测 Radix Dialog 的
   * open-auto-focus 在其后执行、把焦点抢给关闭按钮，机制见 SkillPickerPanel 注释）。
   */
  autoFocusInput?: boolean;
}

export interface SkillPickerPopoverProps extends SkillPickerProps {
  /** 单选回显：当前选中技能（渲染进触发器，重名自动带消歧后缀）。 */
  value?: Skill | null;
  /** 触发器占位文案，默认「（选择技能）」。 */
  triggerPlaceholder?: string;
  /** 弹层宽度 px，默认 320（对齐 SubskillField 现行 Menu width）。 */
  width?: number;
  /** 受控开关（可选），默认内部 state。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 自定义触发器内容（如「技能库外引用」态）；缺省渲染选中名/占位 + ▾。 */
  triggerContent?: (state: { open: boolean; selected: Skill | null }) => ReactNode;
  /** 面板尾部附加内容（如「清除引用」动作），不参与 option 语义。 */
  footer?: ReactNode;
}

/** 面板数据模型：查询 → D-1 命中 → 分组/平铺计划 + 键盘活动项。两种挂载形态共用。 */
function useSkillPickerModel(props: SkillPickerProps) {
  const [innerQuery, setInnerQuery] = useState('');
  const query = props.query ?? innerQuery;
  const setQuery = (next: string) => {
    if (props.query === undefined) setInnerQuery(next);
    props.onQueryChange?.(next);
  };
  const trimmed = query.trim();

  // 空查询不走匹配（D-1 空查询本就原样返回全量）；有查询每次按键本地重算、零请求。
  const hits = useMemo(
    () => (trimmed ? searchSkills(props.candidates, query) : []),
    [props.candidates, query, trimmed],
  );
  const duplicateSource = props.disambiguateOver ?? props.candidates;
  const duplicateNames = useMemo(() => duplicateNameSet(duplicateSource), [duplicateSource]);

  // C-6c①：模型层不做名称窗口化——分组态根本没有命中要保护；查询态的预算来自
  // 每行名称盒的实测宽（PickerRow 里逐行测宽后调 pickerRowNameSegments），恒定全局
  // 预算在模型层截出来的文本对不上行宽，反而制造假省略号。
  const flat: PickerFlatPlan | null = trimmed
    ? buildFlatPlan(hits, duplicateNames, props.limit ?? DEFAULT_PICKER_LIMIT)
    : null;
  const groups: PickerGroupPlan[] | null = flat ? null : buildGroupPlan(props.candidates, duplicateNames);
  /** 键盘导航的扁平行序 = 渲染行序（平铺即 rows；分组按组序拼接）。 */
  const rows: PickerRowPlan[] = flat ? flat.rows : (groups ?? []).flatMap((group) => group.rows);

  const [active, setActive] = useState(0);
  // 查询或结果集变化后回到首行，避免活动项停在已消失的行上（与全局搜索同口径）。
  useEffect(() => {
    setActive(0);
  }, [query, rows.length]);

  return { query, setQuery, trimmed, flat, groups, rows, active, setActive, duplicateNames };
}

type PickerModel = ReturnType<typeof useSkillPickerModel>;

function optionDomId(listId: string, skillId: string): string {
  return `${listId}-opt-${skillId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function Segments({ segments }: { segments: PickerRowPlan['nameSegments'] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="bg-primary-soft text-text-primary">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function PickerRow({
  row,
  domId,
  grouped,
  checked,
  showCheck,
  active,
  onActivate,
  onSelect,
  trailing,
}: {
  row: PickerRowPlan;
  domId: string;
  grouped: boolean;
  checked: boolean;
  showCheck: boolean;
  active: boolean;
  onActivate: () => void;
  onSelect: () => void;
  trailing?: (skill: Skill) => ReactNode;
}) {
  // C-6c② 逐行测名称盒宽：名称 span 是 flex-1 min-w-0，盒宽由兄弟 shrink-0 元素
  // （徽标/版本/消歧后缀）决定、不随自身文本变化 → 一次测量即稳定，不造 render 循环；
  // RO 只为徽标布局变化（分组态↔查询态切换同批行）补测。Math.round 存 state 防浮点抖动。
  const nameBoxRef = useRef<HTMLSpanElement>(null);
  const [nameBoxPx, setNameBoxPx] = useState(0);
  useLayoutEffect(() => {
    const el = nameBoxRef.current;
    if (!el) return;
    const measure = () => {
      const px = Math.round(el.clientWidth);
      setNameBoxPx((prev) => (prev === px ? prev : px));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // C-6c①：窗口化门控与预算换算全在纯函数里（零命中恒全名；未测到宽退化全名）。
  const nameSegments = useMemo(() => pickerRowNameSegments(row, nameBoxPx), [row, nameBoxPx]);

  return (
    <div
      id={domId}
      role="option"
      aria-selected={checked || active}
      title={`${row.label}${row.suffix}`}
      className={cn(
        'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-left text-body text-text-primary',
        'transition-colors duration-140 ease-settle hover:bg-bg-muted',
        active && 'bg-bg-muted',
      )}
      onMouseEnter={onActivate}
      onClick={onSelect}
    >
      {showCheck ? (
        <span className="flex size-4 shrink-0 items-center justify-center">
          {checked ? <Check className="size-3.5 text-primary" aria-hidden /> : null}
        </span>
      ) : null}
      {/* C-6c②③ 名称优先：有命中时 nameSegments 已按本行实测盒宽窗口化（显示宽度
          ≤ 盒宽，命中必落可视区，truncate 只剩极端兜底）；消歧后缀移到 truncate 盒之外
          的 shrink-0 兄弟——给 suffix 的预算预留由布局承担（测得盒宽天然不含它），
          无命中/分组态下 suffix 也恒可见，走查实测的「视觉相同的两行」就此根治。
          行 title 仍是全名 + 消歧后缀。 */}
      <span ref={nameBoxRef} className="min-w-0 flex-1 truncate">
        <Segments segments={nameSegments} />
      </span>
      {row.suffix ? <span className="shrink-0 text-aux text-text-tertiary">{row.suffix}</span> : null}
      {/* 分组态不逐行渲染徽标：分类由组头承载、类型/状态对选技能帮助有限（走查实测
          320px 弹层里徽标把名称挤成 `boge-kaoyan-…`）。查询态只保留必要项：分类文本仅
          当命中落在分类上时出现（交代命中原因），类型徽标恒在；状态徽标两态都撤——
          排除 ARCHIVED 等过滤本归调用方，草稿/已发布对「挑一个技能」决策帮助有限。 */}
      {!grouped && row.categorySegments.some((segment) => segment.hit) ? (
        <span className="shrink-0 text-aux text-text-tertiary">
          <Segments segments={row.categorySegments} />
        </span>
      ) : null}
      {!grouped ? (
        <Badge tone="outline" className="shrink-0">
          <Segments segments={row.typeSegments} />
        </Badge>
      ) : null}
      <span className="shrink-0 font-mono text-badge text-text-tertiary">{row.skill.current_version}</span>
      {trailing ? (
        <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
          {trailing(row.skill)}
        </span>
      ) : null}
    </div>
  );
}

/** 共用面板：搜索输入 + listbox（分组/平铺两态）+ 键盘导航。内联与弹层都渲染它。 */
function SkillPickerPanel({
  props,
  model,
  open,
  onSelectRow,
  inputRef,
  constrainHeight,
  footer,
}: {
  props: SkillPickerProps;
  model: PickerModel;
  /** combobox aria-expanded：内联恒 true，弹层随开关。 */
  open: boolean;
  onSelectRow: (skill: Skill) => void;
  inputRef?: RefObject<HTMLInputElement>;
  /** 内联形态自限高度滚动；弹层形态交给 Popover 的 max-h-[70vh]，避免双层滚动。 */
  constrainHeight: boolean;
  footer?: ReactNode;
}) {
  const listId = useId();
  const selected = new Set(props.selectedIds ?? []);
  const activeRow = model.rows[Math.min(model.active, model.rows.length - 1)];

  // C-6c④：autoFocusInput 的实现从 React 原生 autoFocus 换成挂载后显式 focus。
  // 真机实测 + 读 radix focus-scope 源码定案：Dialog 的 open-auto-focus（focusFirst
  // 抢焦给关闭按钮）跑在 FocusScope 的 passive effect 里——React 原生 autoFocus 在
  // 挂载阶段落焦、被它后手抢走（activeElement=BUTTON）；而同批次 passive effect 按
  // 「子先父后」运行，面板里同步 focus() 同样会被祖先的 FocusScope effect 覆写。
  // 故在面板 effect 里排一个微任务：passive effect 批处理是同步跑完的，微任务恒在
  // 整批（含祖先）之后执行，焦点确定性最后落进搜索框。不给共享 Dialog 加 props、
  // 不用可被 preventDefault 的 onOpenAutoFocus 事件钩子，其余 Dialog 调用点零影响。
  const ownInputRef = useRef<HTMLInputElement>(null);
  const focusRef = inputRef ?? ownInputRef;
  useEffect(() => {
    if (!props.autoFocusInput) return;
    let committed = true;
    queueMicrotask(() => {
      if (committed) focusRef.current?.focus();
    });
    return () => {
      committed = false;
    };
  }, [props.autoFocusInput, focusRef]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (model.rows.length === 0) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      model.setActive((model.active + delta + model.rows.length) % model.rows.length);
      return;
    }
    if (event.key === 'Enter' && activeRow) {
      event.preventDefault();
      onSelectRow(activeRow.skill);
    }
    // Esc 不拦截：内联无层可关；弹层形态由 Radix 的 onEscapeKeyDown 收层（外层语义归调用方）。
  };

  let cursor = -1; // 扁平行游标：分组/平铺都按 rows 的渲染顺序编号。
  const nextIndex = () => {
    cursor += 1;
    return cursor;
  };

  const renderRow = (row: PickerRowPlan, grouped: boolean) => {
    const index = nextIndex();
    return (
      <PickerRow
        key={row.skill.id}
        row={row}
        domId={optionDomId(listId, row.skill.id)}
        grouped={grouped}
        checked={selected.has(row.skill.id)}
        showCheck={props.multiple === true}
        active={index === Math.min(model.active, model.rows.length - 1)}
        onActivate={() => model.setActive(index)}
        onSelect={() => onSelectRow(row.skill)}
        trailing={props.trailing}
      />
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <Input
        ref={focusRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeRow ? optionDomId(listId, activeRow.skill.id) : undefined}
        aria-label={props.ariaLabel ?? props.placeholder ?? '搜索技能'}
        value={model.query}
        placeholder={props.placeholder ?? '搜索技能（名称 / 分类 / 类型 / 标签 / ID）'}
        disabled={props.disabled}
        // C-6b③/C-6c④：autoFocusInput 走挂载后显式 focus（见上方 focusRef 注释），
        // 不用 React 原生 autoFocus——那会被 Radix Dialog 的 open-auto-focus 后手抢走。
        className={props.inputClassName}
        onChange={(event) => model.setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div
        id={listId}
        role="listbox"
        aria-label={props.ariaLabel ?? '技能候选'}
        className={cn('flex min-w-0 flex-col', constrainHeight && 'max-h-[320px] overflow-y-auto atb-scroll')}
      >
        {model.trimmed ? (
          model.flat && model.flat.total > 0 ? (
            <>
              <p className="px-2 py-1 text-aux text-text-tertiary">命中 {model.flat.total} 条</p>
              {model.flat.rows.map((row) => renderRow(row, false))}
              {model.flat.truncated ? (
                <p className="px-2 py-1 text-aux text-text-tertiary">结果过多，请细化查询</p>
              ) : null}
            </>
          ) : (
            <p className="px-2 py-2 text-aux text-text-tertiary">
              没有匹配「{model.query.trim()}」的技能
            </p>
          )
        ) : model.groups && model.groups.length > 0 ? (
          model.groups.map((group) => (
            <div key={group.key || '__uncategorized'}>
              <p className="px-2 pb-1 pt-2 text-aux text-text-tertiary">{group.title}</p>
              {group.rows.map((row) => renderRow(row, true))}
            </div>
          ))
        ) : (
          <p className="px-2 py-2 text-aux text-text-tertiary">{props.emptyText ?? '没有可选技能'}</p>
        )}
      </div>
      {footer}
    </div>
  );
}

/** 内联形态：搜索框 + 面板就地渲染（任务详情「绑定技能」区用）。 */
export function SkillPicker({ className, ...rest }: SkillPickerProps) {
  const model = useSkillPickerModel(rest);
  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <SkillPickerPanel
        props={rest}
        model={model}
        open
        constrainHeight
        onSelectRow={(skill) => rest.onSelect(skill)}
      />
    </div>
  );
}

/** 弹层形态：触发器显示当前选中（或占位），点开是同一份面板（子技能引用用）。 */
export function SkillPickerPopover({
  value,
  triggerPlaceholder = '（选择技能）',
  width = 320,
  open: openProp,
  onOpenChange,
  triggerContent,
  footer,
  ...core
}: SkillPickerPopoverProps) {
  const model = useSkillPickerModel(core);
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  // 打开时焦点直接进面板内搜索框（Popover 默认 preventOpenAutoFocus，焦点原留在触发器）。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const selected = core.multiple ? null : (value ?? null);
  const selectedLabel = selected
    ? model.duplicateNames.has(selected.name)
      ? `${selected.name} ·${selected.id.slice(-6)}`
      : selected.name
    : triggerPlaceholder;

  const onSelectRow = (skill: Skill) => {
    core.onSelect(skill);
    // 多选选中后面板不关（反复点开是旧原生 select 的用户痛点）；单选确认即收层并清查询词。
    if (!core.multiple) {
      setOpen(false);
      model.setQuery('');
    }
  };

  const anchor = (
    <span ref={anchorRef} className="relative block w-full">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={core.disabled}
        className={cn(
          'flex h-8 w-full items-center justify-between gap-2 rounded-control border border-border bg-bg-raised px-3 text-left text-body text-text-primary',
          'transition-colors duration-140 ease-settle hover:border-border-strong',
          'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
        onClick={() => setOpen(!open)}
      >
        {triggerContent ? (
          triggerContent({ open, selected })
        ) : (
          <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-text-tertiary')}>{selectedLabel}</span>
        )}
        <ChevronDown className="pointer-events-none size-4 shrink-0 text-text-tertiary" aria-hidden />
      </button>
    </span>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // 壳不内置 Trigger：Radix dismiss 只回调 false，开合仍由触发器 state 驱动（全局搜索同口径）。
        if (!next) setOpen(false);
      }}
      anchor={anchor}
      contentWidth={width}
      preventOpenAutoFocus
      onEscapeKeyDown={(event) => {
        // Esc 两段语义：第一下收层（不 preventDefault，交给 Radix），层已关时不拦输入框。
        if (!open) event.preventDefault();
      }}
      // 点锚点自身不算层外（否则 Radix 先 dismiss、触发器再 toggle，连起来永远关不掉）。
      onInteractOutside={(event) => {
        if (anchorRef.current && anchorRef.current.contains(event.target as Node)) event.preventDefault();
      }}
    >
      <SkillPickerPanel props={core} model={model} open={open} constrainHeight={false} onSelectRow={onSelectRow} inputRef={inputRef} footer={footer} />
    </Popover>
  );
}

/** 供调用方做触发器/回显文案的消歧名（口径与面板行一致）。 */
export function skillPickerDisplayLabel(
  skill: Skill,
  duplicateNames: ReadonlySet<string>,
): string {
  return duplicateNames.has(skill.name) ? `${skill.name} ·${skill.id.slice(-6)}` : skill.name;
}

/** 类型中文标签（行的类型列与调用方回显共用，避免各拼一份 SKILL_TYPE_META 访问）。 */
export function skillTypeLabel(skill: Skill): string {
  return SKILL_TYPE_META[skill.type].label;
}
