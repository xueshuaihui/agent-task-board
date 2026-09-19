import { useEffect, useMemo, useState } from 'react';
import { Copy, Search } from 'lucide-react';
import { Button, Dialog, EmptyState, Input } from '@/components/ui';
import { errorMessage } from '@/api';
import { SKILL_TYPE_META } from './meta';
import { useSkills } from './hooks';
import type { Skill } from './types';

/**
 * 「复制现有技能」的技能选择器：搜索 + 列表，选中后由页面用
 * GET /skills/:id 拿内容并 POST /skills 创建副本（名称加「副本」后缀）。
 */

export interface CopySkillPickerProps {
  open: boolean;
  onClose: () => void;
  onPicked: (skill: Skill) => void;
}

export function CopySkillPicker({ open, onClose, onPicked }: CopySkillPickerProps) {
  const [keyword, setKeyword] = useState('');
  const skills = useSkills(keyword ? { keyword } : undefined);

  useEffect(() => {
    if (open) setKeyword('');
  }, [open]);

  const items = useMemo(() => skills.data?.items ?? [], [skills.data]);

  return (
    <Dialog open={open} onClose={onClose} title="复制技能">
      {items.length === 0 && !skills.isPending ? (
        <EmptyState title="没有可复制的技能" description="先创建或导入一个技能" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-tertiary" />
            <Input
              value={keyword}
              placeholder="搜索技能…"
              className="pl-8"
              onChange={(event) => setKeyword(event.target.value)}
              autoFocus
            />
          </div>
          <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1 atb-scroll">
            {skills.isPending ? (
              <p className="py-6 text-center text-aux text-text-tertiary">加载中…</p>
            ) : skills.isError ? (
              <p className="py-6 text-center text-aux text-status-failed">{errorMessage(skills.error)}</p>
            ) : items.length === 0 ? (
              <p className="py-6 text-center text-aux text-text-tertiary">没有匹配的技能</p>
            ) : (
              items.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => {
                    onClose();
                    onPicked(skill);
                  }}
                  className="flex items-center gap-2 rounded-control border border-border bg-bg-surface px-3 py-2 text-left transition-colors hover:border-primary/60 hover:bg-bg-raised"
                >
                  <Copy className="size-4 shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-text-primary">{skill.name}</span>
                    <span className="block truncate text-aux text-text-secondary">
                      {SKILL_TYPE_META[skill.type]?.label ?? skill.type} · {skill.content.blocks.length} 个块
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <p className="text-aux text-text-tertiary">复制会创建一个新草稿，名称自动加「副本」后缀。</p>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="default" onClick={onClose}>
          取消
        </Button>
      </div>
    </Dialog>
  );
}
