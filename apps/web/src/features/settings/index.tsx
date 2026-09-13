import type { ComponentType } from 'react';
import { cn } from '@/lib/cn';
import { SETTINGS_TABS, useSettingsTab } from './tabs';
import type { SettingsTabId } from './tabs';
import { GeneralTab } from './tabs/general';
import { TokensTab } from './tabs/tokens';
import { FieldsTab } from './tabs/fields';
import { TemplatesTab } from './tabs/templates';
import { DataTab } from './tabs/data';
import { LogsTab } from './tabs/logs';
import { BackupsTab } from './tabs/backups';
import { AboutTab } from './tabs/about';

/**
 * 设置页 `#/settings`（PRD 8.5 八个 Tab，控件规格原型 7 章）。
 *
 * 布局按原型 7.1：左侧 200px 竖排八项（项高 40px，选中=左侧 3px 主色条 + 主色浅底，
 * 未选中 `--text-secondary`）+ 右侧内容区。Tab 值同步进 hash（`#/settings?tab=tokens`），
 * 所以托盘「设置」与深链都能落到指定 Tab，刷新也不回退。
 *
 * 侧栏 `sticky`：内容区由 `app.tsx` 的 `main` 负责滚动（2.1），八项跟着视口走才不用滚回顶部换 Tab。
 */
const PANELS: Record<SettingsTabId, ComponentType> = {
  general: GeneralTab,
  tokens: TokensTab,
  fields: FieldsTab,
  templates: TemplatesTab,
  data: DataTab,
  logs: LogsTab,
  backups: BackupsTab,
  about: AboutTab,
};

export function SettingsPage() {
  const { tab, select } = useSettingsTab();
  const Panel = PANELS[tab];

  return (
    <div className="flex min-h-full items-start gap-6">
      <nav aria-label="设置分类" className="sticky top-0 w-[200px] shrink-0">
        <ul className="flex flex-col">
          {SETTINGS_TABS.map((item) => {
            const active = item.id === tab;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => select(item.id)}
                  className={cn(
                    'flex h-10 w-full items-center border-l-[3px] px-4 text-nav transition-colors duration-120 ease-out',
                    active
                      ? 'border-l-primary bg-primary-light text-text-primary'
                      : 'border-l-transparent text-text-secondary hover:bg-bg-muted hover:text-text-primary',
                  )}
                >
                  <span className="truncate">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1">
        <Panel />
      </div>
    </div>
  );
}
