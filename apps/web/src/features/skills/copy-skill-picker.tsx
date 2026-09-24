import { useMemo } from 'react';
import { Button, Dialog, EmptyState } from '@/components/ui';
import { errorMessage } from '@/api';
import { useSkills } from './hooks';
import { SkillPicker } from './skill-picker';
import type { Skill } from './types';

/**
 * 「复制现有技能」的技能选择器：弹窗内就地展示共享 SkillPicker（内联形态），
 * 选中后由页面用 GET /skills/:id 拿内容并 POST /skills 创建副本（名称加「副本」后缀）。
 *
 * D-4（条款 83 收口）：第四处「选技能」入口此前自绘搜索框 + 自绘列表，并把搜索词
 * 作为查询参数传给 GET /skills——每次按键一次服务端请求。现在技能列表一次性全量
 * 在手（`useSkills()`，与另三处接线同一取数口径），查询匹配交 SkillPicker 内部调
 * searchSkills 本地算，搜索零请求、`GET /skills` 不因搜索新增查询参数。
 * 取数与业务分支仍归本页：加载/失败/无技能三种状态留在调用方（组件不管取数），
 * 原每行的「N 个块」信息经 trailing 插槽保留（类型中文标签组件行里已有）。
 */

export interface CopySkillPickerProps {
  open: boolean;
  onClose: () => void;
  onPicked: (skill: Skill) => void;
}

export function CopySkillPicker({ open, onClose, onPicked }: CopySkillPickerProps) {
  const skills = useSkills();
  const items = useMemo(() => skills.data?.items ?? [], [skills.data]);

  return (
    <Dialog open={open} onClose={onClose} title="复制技能">
      {skills.isPending ? (
        <p className="py-6 text-center text-aux text-text-tertiary">加载中…</p>
      ) : skills.isError ? (
        <p className="py-6 text-center text-aux text-status-failed">{errorMessage(skills.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState title="没有可复制的技能" description="先创建或导入一个技能" />
      ) : (
        <div className="flex flex-col gap-3">
          <SkillPicker
            candidates={items}
            disambiguateOver={items}
            ariaLabel="选择要复制的技能"
            placeholder="搜索技能（名称 / 分类 / 类型 / 标签 / ID）"
            // C-6b③/C-6c④：搜索是这处的唯一主操作，弹窗打开即聚焦搜索框（改造前是原生
            // autoFocus，D-4 换内联 SkillPicker 后丢了）。开关默认关闭，其余调用不受影响；
            // 聚焦由面板挂载后的显式 focus 完成——原生 autoFocus 会被 Radix Dialog 的
            // open-auto-focus 后手抢给关闭按钮（真机实测），组件内已换机制。
            autoFocusInput
            onSelect={(skill) => {
              onClose();
              onPicked(skill);
            }}
            trailing={(skill) => (
              <span className="text-aux text-text-tertiary">{skill.content.blocks.length} 个块</span>
            )}
          />
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
