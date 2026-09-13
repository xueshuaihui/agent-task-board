import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { Badge, Button, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { clampText } from '../utils';

export interface ChipEditorProps {
  values: readonly string[];
  onChange: (next: string[]) => void;
  /** 输入校验：返回错误文案即拒绝写入（20.5 的 `namespace:value` 就靠它）。 */
  validate?: (raw: string) => string | null;
  /** 列表长度上限（20.9 `task_types` ≤ 20、13 章 capabilities ≤ 20）。 */
  max?: number;
  /** 单项长度上限（20.3 词表项 ≤ 16）。 */
  maxEach?: number;
  placeholder?: string;
  addLabel?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  /**
   * 删除闸门：返回字符串即中止删除并把这句话作为提示显示出来。
   * 7.2 的「删除后不影响 N 个已有任务」走的是确认框，由调用方在这里挂。
   */
  guardRemove?: (value: string) => string | null;
  /**
   * 代删：给了它，`×` 就不再直接改 `values`，而是把删除请求交给调用方。
   * 词表那一项要先查一次「有多少任务还在用这个类型」才能写出确认文案（7.2），
   * 异步查询不该塞进这个通用组件里。
   */
  onRemoveRequest?: (value: string) => void;
  /** 已有值的展示修饰（如词表把当前值渲染成彩色 chip）。 */
  tone?: 'neutral' | 'outline';
}

/**
 * 原型 7.2「任务类型词表」与 7.3「能力集」、7.5「标签」共用的 chip 输入。
 *
 * 三处形态一样（值列表 + `×` + `[+ 添加]`），差别只在校验规则与长度上限，
 * 所以做成一个受控组件、规则由 props 注入。添加即时去重：词表里两个同名类型
 * 在服务端不会被合并（20.3 按字符串全等匹配），留到界面挡掉更省事。
 */
export function ChipEditor({
  values,
  onChange,
  validate,
  max,
  maxEach,
  placeholder = '输入后回车添加',
  addLabel = '添加',
  disabled,
  id,
  className,
  guardRemove,
  onRemoveRequest,
  tone = 'neutral',
}: ChipEditorProps) {
  const [draft, setDraft] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const atLimit = max !== undefined && values.length >= max;

  const flush = () => {
    const raw = draft.trim();
    if (!raw) {
      setIssue(null);
      return;
    }
    if (max !== undefined && values.length >= max) {
      setIssue(`最多 ${max} 项`);
      return;
    }
    const value = maxEach !== undefined ? clampText(raw, maxEach) : raw;
    if (values.some((item) => item.toLowerCase() === value.toLowerCase())) {
      setIssue('已存在同样的项');
      return;
    }
    const error = validate?.(value);
    if (error) {
      setIssue(error);
      return;
    }
    onChange([...values, value]);
    setDraft('');
    setIssue(null);
    inputRef.current?.focus();
  };

  const remove = (value: string) => {
    const blocked = guardRemove?.(value);
    if (blocked) {
      setIssue(blocked);
      return;
    }
    setIssue(null);
    if (onRemoveRequest) {
      onRemoveRequest(value);
      return;
    }
    onChange(values.filter((item) => item !== value));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      flush();
    }
  };

  const hint = useMemo(() => {
    if (issue) return issue;
    if (atLimit) return `已达 ${max} 项上限`;
    return null;
  }, [issue, atLimit, max]);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((value) => (
          <Badge key={value} tone={tone} className="max-w-full">
            <span className="shrink-0">{value}</span>
            {disabled ? null : (
              <button
                type="button"
                aria-label={`删除 ${value}`}
                className="-mr-0.5 inline-flex shrink-0 items-center rounded-tag p-px hover:bg-border"
                onClick={() => remove(value)}
              >
                <X className="size-3" />
              </button>
            )}
          </Badge>
        ))}
        {values.length === 0 && disabled ? (
          <span className="text-aux text-text-tertiary">无</span>
        ) : null}
        {disabled || atLimit ? null : (
          <div className="flex items-center gap-1">
            <Input
              id={id}
              ref={inputRef}
              className="h-8 w-[168px]"
              value={draft}
              invalid={Boolean(issue)}
              placeholder={placeholder}
              onChange={(event) => {
                setDraft(event.target.value);
                setIssue(null);
              }}
              onKeyDown={onKeyDown}
            />
            <Button size="sm" variant="default" icon={<Plus className="size-4" />} onClick={flush}>
              {addLabel}
            </Button>
          </div>
        )}
      </div>
      {hint ? <p className="text-aux text-status-failed">{hint}</p> : null}
    </div>
  );
}
