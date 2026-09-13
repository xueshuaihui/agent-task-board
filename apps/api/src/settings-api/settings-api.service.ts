import { Injectable } from '@nestjs/common';
import type { Settings } from '../contract/settings';
import { AuditService } from '../infra/audit.service';
import { AppLogger } from '../infra/logger';
import { SettingsService } from '../infra/settings.service';

/**
 * 设置页读写的一层薄壳：读写本身在 `infra/settings.service.ts`（含 20.9 键表校验，
 * 未知键与越界一律 422，这里原样透传），本层只补两件基础设施不该管的事——
 * 审计留痕，以及 `log_level` 的热生效。
 */
@Injectable()
export class SettingsApiService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  all(): Promise<Settings> {
    return this.settings.all();
  }

  async patch(entries: Record<string, unknown>): Promise<Settings> {
    const before = await this.settings.all();
    const after = await this.settings.patch(entries);
    this.applyLoggerSettings(before, after);

    const changed = (Object.keys(after) as (keyof Settings)[]).filter(
      (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
    );
    if (changed.length > 0) {
      await this.audit.record({
        actorType: 'user',
        action: 'settings_change',
        targetType: 'settings',
        targetId: 'settings',
        // 只记变化的那几项：一次改一个键时，12 个键的全表快照没有信息量。
        before: pick(before, changed),
        after: pick(after, changed),
      });
    }
    return after;
  }

  /** 20.9 标了热生效的两项：`log_level` 改现有 transport，`log_retention_days` 换掉它。 */
  private applyLoggerSettings(before: Settings, after: Settings): void {
    if (before.log_level !== after.log_level) this.logger.setLevel(after.log_level);
    if (before.log_retention_days !== after.log_retention_days) {
      this.logger.applyRetentionDays(after.log_retention_days);
    }
  }
}

function pick(settings: Settings, keys: (keyof Settings)[]): Partial<Settings> {
  return Object.fromEntries(keys.map((key) => [key, settings[key]])) as Partial<Settings>;
}
