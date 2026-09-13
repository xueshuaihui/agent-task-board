import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import {
  DEFAULT_SETTINGS,
  decodeSetting,
  encodeSetting,
  isSettingsKey,
  validateSetting,
  type Settings,
  type SettingsKey,
} from '../contract/settings';
import { nowSql } from '../contract/time';
import { PrismaService } from './prisma.service';

/**
 * 20.9 的「热生效」指无需重启 sidecar，不是每次读库：读路径走内存缓存，
 * 写入后立即失效回填，因此同一进程内不存在读到旧值的时间窗。
 */
@Injectable()
export class SettingsService {
  private cache: Settings | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async all(): Promise<Settings> {
    if (this.cache) return this.cache;
    const rows = await this.prisma.setting.findMany();
    const stored = new Map(rows.map((row) => [row.key, row.value]));
    this.cache = Object.fromEntries(
      (Object.keys(DEFAULT_SETTINGS) as SettingsKey[]).map((key) => [
        key,
        stored.has(key) ? decodeSetting(key, stored.get(key) as string) : DEFAULT_SETTINGS[key],
      ]),
    ) as Settings;
    return this.cache;
  }

  async get<K extends SettingsKey>(key: K): Promise<Settings[K]> {
    return (await this.all())[key];
  }

  invalidate(): void {
    this.cache = null;
  }

  async patch(entries: Record<string, unknown>): Promise<Settings> {
    for (const [key, raw] of Object.entries(entries)) {
      if (!isSettingsKey(key)) {
        throw new ApiException('VALIDATION_FAILED', `未知设置项 ${key}`, [
          { path: key, code: 'unknown_key', message: '不在 20.9 键总表内' },
        ]);
      }
      const checked = validateSetting(key, raw);
      if (!checked.ok) {
        throw new ApiException('VALIDATION_FAILED', `设置项 ${key} 不合法`, [
          { path: key, code: 'out_of_range', message: checked.message },
        ]);
      }
      const value = encodeSetting(checked.value);
      await this.prisma.setting.upsert({
        where: { key },
        create: { key, value },
        update: { value, updatedAt: nowSql() },
      });
    }
    this.invalidate();
    return this.all();
  }
}
