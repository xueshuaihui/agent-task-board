import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { Button, Dialog, useToast } from '@/components/ui';
import { errorMessage } from '@/api';
import { useImportSkill } from './hooks';
import type { Skill } from './types';

/**
 * 导入 .atskill（文件选择 + POST /skills/import）。后端未就绪前按钮会把
 * 接口错误原样 Toast 出来，方便联调。
 */

export interface ImportSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (skill: Skill) => void;
}

export function ImportSkillDialog({ open, onClose, onImported }: ImportSkillDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const toast = useToast();
  const importSkill = useImportSkill((skill) => {
    onClose();
    onImported(skill);
  });

  const submit = (file: File) => {
    if (!file.name.endsWith('.atskill')) {
      toast.warning('请选择 .atskill 文件');
      return;
    }
    importSkill.mutate(file, {
      onError: (error) => toast.error('导入失败', errorMessage(error)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="导入技能"
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={importSkill.isPending}
            disabled={!fileName}
            onClick={() => inputRef.current?.click()}
          >
            选择 .atskill 文件
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border px-6 py-8 text-center">
        <Upload className="size-6 text-text-tertiary" />
        <p className="text-body text-text-secondary">
          {fileName ? `已选择：${fileName}` : '支持 .atskill（JSON）技能文件'}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".atskill,application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setFileName(file.name);
              submit(file);
            }
            event.target.value = '';
          }}
        />
      </div>
    </Dialog>
  );
}
