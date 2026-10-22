import os from 'node:os';
import path from 'node:path';

/**
 * adapter 解析路径所需的「用户环境」。
 *
 * WHY 不直接读 `process.env`：用户级路径必须能在测试里换成临时 home，
 * 否则跑一次 adapter 用例就会往真机的 `~/.claude`、`~/.codex` 里探路径。
 * `platform` 显式带在环境里，后续 Windows 专属分支（junction、盘符）也走同一入口。
 */
export interface ClientEnv {
  platform: NodeJS.Platform;
  home: string;
  appData: string;
}

/**
 * `ATB_CLIENT_HOME` 与 `ATB_LOGS_DIR` 同定位：只为测试存在，应用运行时不注入。
 * Windows 的 appData 取 `APPDATA`，缺失时退回 `%USERPROFILE%\AppData\Roaming`；
 * 其它平台给 `~/.config` 占位——当前 adapter 不消费 appData，先保持与 XDG 一致。
 */
export function resolveClientEnv(src: NodeJS.ProcessEnv = process.env): ClientEnv {
  const platform = process.platform;
  const home = path.resolve(src.ATB_CLIENT_HOME || os.homedir());
  const appData =
    platform === 'win32'
      ? path.resolve(src.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : path.join(home, '.config');
  return { platform, home, appData };
}
