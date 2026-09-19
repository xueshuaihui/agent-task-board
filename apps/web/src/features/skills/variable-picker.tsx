import { useRef } from 'react';
import { Braces } from 'lucide-react';
import { Menu, Textarea, type TextareaProps } from '@/components/ui';
import type { VariableOption } from './meta';

/**
 * 变量系统辅助（1.md 8.3 编辑器智能辅助）：文本输入框旁的变量插入下拉。
 * 选项由 meta.inferVariableOptions 从技能 input 块与上游块输出推断。
 */

export interface VariableMenuProps {
  options: VariableOption[];
  onInsert: (expression: string) => void;
}

export function VariableMenu({ options, onInsert }: VariableMenuProps) {
  const groups = new Map<string, VariableOption[]>();
  for (const option of options) {
    const list = groups.get(option.group) ?? [];
    list.push(option);
    groups.set(option.group, list);
  }
  return (
    <Menu
      width={240}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-tag border border-border px-2 text-aux text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          aria-label="插入变量"
        >
          <Braces className="size-3.5" />
          变量
        </button>
      )}
      groups={[...groups.entries()].map(([label, list]) => ({
        label,
        items: list.map((option) => ({
          id: option.path,
          label: (
            <span className="flex flex-col">
              <span className="font-mono text-aux">{`{{${option.path}}}`}</span>
              <span className="text-aux text-text-tertiary">{option.label}</span>
            </span>
          ),
          onSelect: () => onInsert(option.path),
        })),
      }))}
    />
  );
}

/** 带「插入变量」下拉的多行文本框：变量插到光标处，失去焦点不丢光标位置。 */
export function VariableTextarea({
  options,
  value,
  onChange,
  ...rest
}: Omit<TextareaProps, 'value' | 'onChange'> & {
  options: VariableOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef<number | null>(null);

  const insert = (expression: string) => {
    const element = ref.current;
    const cursor = cursorRef.current ?? value.length;
    const before = value.slice(0, cursor);
    const after = value.slice(cursor);
    const snippet = `{{${expression}}}`;
    const next = `${before}${snippet}${after}`;
    onChange(next);
    // 重设光标到插入片段之后（React 重渲染后 textarea 值才更新，推迟一帧）。
    requestAnimationFrame(() => {
      const position = cursor + snippet.length;
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  return (
    <div className="flex items-start gap-2">
      <Textarea
        {...rest}
        ref={ref}
        value={value}
        onChange={(event) => {
          cursorRef.current = event.target.selectionStart;
          onChange(event.target.value);
        }}
        onBlur={(event) => {
          cursorRef.current = event.target.selectionStart;
        }}
      />
      <VariableMenu options={options} onInsert={insert} />
    </div>
  );
}
