import { useState } from 'react';
import { Cloud, Store } from 'lucide-react';
import { Button, Checkbox, Dialog, Field, Input, Select, useToast } from '@/components/ui';
import { useCloudStatus, useMarketCloudPublish, useMarketPublish } from './hooks';
import { MARKET_CATEGORIES, COMPATIBLE_CLIENTS } from './types';

/**
 * 「发布到市场」对话框（2.md 12.6/十四章我的发布）：
 * 可见性（私有=仅记录不上架 UNLISTED / 公开=提交审核 PENDING_REVIEW）、
 * 分类（12.1 词表）、license、兼容客户端多选。提交成功 Toast 指向个人中心-我的发布。
 *
 * 接缝：本组件由 features/market 导出，技能库卡片菜单 / 技能详情抽屉的
 * 「发布到市场」菜单项挂它（features/skills 由另一改动并行进行，接线处
 * `<MarketPublishDialog open skillId={skill.id} onClose={...} />`）。
 */
export interface MarketPublishDialogProps {
  open: boolean;
  skillId: string;
  onClose: () => void;
}

export function MarketPublishDialog({ open, skillId, onClose }: MarketPublishDialogProps) {
  const toast = useToast();
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [category, setCategory] = useState<string>('');
  const [license, setLicense] = useState('MIT');
  const [clients, setClients] = useState<string[]>([]);

  const publish = useMarketPublish(() => {
    toast.success(
      '已提交到市场',
      visibility === 'public' ? '审核通过后上架，可在个人中心-我的发布查看进度' : '已记录为私有发布，可在个人中心-我的发布查看',
    );
    onClose();
  });

  // 0919 服务端市场：connected 时给出「发布到服务端市场」入口（服务端直发无审核流）
  const cloudStatus = useCloudStatus({ enabled: open });
  const connected = cloudStatus.data?.connected ?? false;
  const cloudPublish = useMarketCloudPublish(() => {
    toast.success('已发布到服务端市场', `以 ${cloudStatus.data?.username ?? ''} 身份上架，可在服务端市场检索`);
    onClose();
  });

  const toggleClient = (client: string) => {
    setClients((prev) => (prev.includes(client) ? prev.filter((item) => item !== client) : [...prev, client]));
  };

  const submit = () => {
    if (!category) {
      toast.error('请选择分类');
      return;
    }
    publish.mutate({ skill_id: skillId, visibility, category, license, compatible_clients: clients });
  };

  const submitCloud = () => {
    if (!category) {
      toast.error('请选择分类');
      return;
    }
    // 服务端直发：private 同样按原样上传，由服务端决定可见性
    cloudPublish.mutate({
      skill_id: skillId,
      visibility: visibility === 'public' ? 'public' : 'private',
      category,
      license,
      compatible_clients: clients,
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <Store className="size-4 text-primary" aria-hidden />
          发布到市场
        </span>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          {connected ? (
            <Button variant="primary" loading={cloudPublish.isPending} onClick={submitCloud}>
              <Cloud className="size-4" aria-hidden />
              发布到服务端市场
            </Button>
          ) : null}
          <Button variant="primary" loading={publish.isPending} onClick={submit}>
            {visibility === 'public' ? '提交审核' : '保存为私有'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {connected ? (
          <div className="inline-flex items-center gap-1.5 text-aux text-text-secondary">
            <Cloud className="size-4 text-primary" aria-hidden />
            ☁ 已连接服务端市场（{cloudStatus.data?.username}）：可直接发布同步到服务端，服务端失败原因会原样透出
          </div>
        ) : null}
        <Field label="可见性" hint="私有发布仅作记录不上架；公开发布提交管理员审核">
          <Select
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as 'public' | 'private')}
            options={[
              { value: 'public', label: '公开（提交审核）' },
              { value: 'private', label: '私有（仅记录，不上架）' },
            ]}
          />
        </Field>
        <Field label="分类" required>
          <Select
            value={category}
            placeholder="选择分类"
            onChange={(event) => setCategory(event.target.value)}
            options={MARKET_CATEGORIES.map((item) => ({ value: item, label: item }))}
          />
        </Field>
        <Field label="License">
          <Input value={license} maxLength={100} placeholder="如 MIT / Apache-2.0" onChange={(event) => setLicense(event.target.value)} />
        </Field>
        <Field label="兼容客户端" hint="不选表示不限">
          <div className="flex flex-wrap items-center gap-3">
            {COMPATIBLE_CLIENTS.map((client) => (
              <Checkbox
                key={client}
                label={client}
                checked={clients.includes(client)}
                onChange={() => toggleClient(client)}
              />
            ))}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
