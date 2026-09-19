import { Store } from 'lucide-react';
import { EmptyState } from '@/components/ui';

/**
 * 1.md 十四章信息架构里的「市场（云端）」顶栏入口的落地页。
 *
 * 已拍板：云端市场本期不落地——本期只占位，不做浏览 / 搜索 / 订阅的任何实现。
 * 页面给品牌化空状态：说明本地技能创作与导入导出已可用（第十章），云端订阅 / 发布
 * 待云端服务开通。顶栏导航项带「即将上线」小徽标（app/top-bar.tsx）。
 */
export function MarketPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={<Store className="size-10" aria-hidden />}
        title="云端市场即将上线"
        description="本地技能创作与导入导出已可用；云端订阅、发布等能力待云端服务开通后开放，敬请期待。"
        className="w-full max-w-[520px] border-solid px-8 py-16"
      />
    </div>
  );
}
