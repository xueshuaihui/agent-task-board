import type { ComponentType } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/cn';
import { springs, transitions } from '@/lib/motion';
import { SETTINGS_TABS, useSettingsTab } from './tabs';
import type { SettingsTabId } from './tabs';
import { GeneralTab } from './tabs/general';
import { ViewTab } from './tabs/view';
import { TokensTab } from './tabs/tokens';
import { FieldsTab } from './tabs/fields';
import { TemplatesTab } from './tabs/templates';
import { DataTab } from './tabs/data';
import { LogsTab } from './tabs/logs';
import { BackupsTab } from './tabs/backups';
import { AboutTab } from './tabs/about';

/**
 * 设置页 `#/settings`（PRD 8.5 的 Tab 集合，控件规格原型 7 章；v0.0.4 W1a 移除「服务端市场」Tab）。
 *
 * 视觉层（DESIGN.md §4 设置行）：左侧分区导航 sticky 跟随视口，token 卡片容器
 * （surface 底 + border + shadow-card），激活项由 motion `layoutId` 滑动胶囊指示
 * （springs.gentle，与顶栏导航同语言），激活 `text-text-primary`、未激活 `text-text-secondary`。
 * 右侧内容区按 Tab 淡入切换；页面整体按 §5 的 rise 入场。
 *
 * Tab 值同步进 hash（`#/settings?tab=tokens`），所以托盘「设置」与深链都能落到指定 Tab，
 * 刷新也不回退。侧栏 `sticky`：内容区由 `app.tsx` 的 `main` 负责滚动（2.1），
 * 各项跟着视口走才不用滚回顶部换 Tab。
 */
const PANELS: Record<SettingsTabId, ComponentType> = {
  general: GeneralTab,
  view: ViewTab,
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
  const reduced = useReducedMotion();
  const Panel = PANELS[tab];

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transitions.rise}
      className="flex min-h-full items-start gap-6"
    >
      <nav aria-label="设置分类" className="sticky top-0 w-[200px] shrink-0">
        <ul className="flex flex-col rounded-card border border-border bg-bg-surface p-1.5 shadow-card">
          {SETTINGS_TABS.map((item) => {
            const active = item.id === tab;
            return (
              <li key={item.id} className="relative">
                {active ? (
                  <motion.span
                    layoutId="settings-nav-active"
                    aria-hidden
                    className="absolute inset-0 rounded-control bg-primary-light"
                    transition={reduced ? { duration: 0 } : springs.gentle}
                  />
                ) : null}
                <button
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => select(item.id)}
                  className={cn(
                    'relative z-10 flex h-10 w-full items-center rounded-control px-3 text-nav transition-colors duration-140 ease-settle',
                    active
                      ? 'text-text-primary'
                      : 'text-text-secondary hover:text-text-primary',
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
        <motion.div
          key={tab}
          initial={reduced ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={transitions.fade}
        >
          <Panel />
        </motion.div>
      </div>
    </motion.div>
  );
}
