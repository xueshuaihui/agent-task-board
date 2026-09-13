import type { ReactNode } from 'react';
import { Button, Dialog } from '@/components/ui';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** 主文案（原型 10.5 的两行）。 */
  description?: ReactNode;
  /** 次级说明：不可逆范围、服务端口径（如 9.3 的产物不在备份内）。 */
  detail?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 不可逆操作走 `danger`（4.5：danger=删除/强制停止这一类）。 */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * 原型 10.5 的确认弹窗。
 *
 * `components/ui` 没有导出 ConfirmDialog（基座只给了 `Dialog` 壳），
 * 而设置页有四处需要它：删词表项（7.2）、吊销 Token（7.3）、删字段（7.4）、
 * 删模板（7.5）、恢复备份（7.8）——所以在这里组合一个，不改基座。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  detail,
  confirmText = '确认',
  cancelText = '取消',
  danger,
  loading,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      dismissible={!loading}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {description ? (
        <p className="text-body text-text-primary">{description}</p>
      ) : null}
      {detail ? (
        <p className="mt-2 text-aux leading-relaxed text-text-tertiary">{detail}</p>
      ) : null}
    </Dialog>
  );
}
