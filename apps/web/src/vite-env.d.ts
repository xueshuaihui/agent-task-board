/// <reference types="vite/client" />

/** vite.config.ts 的 `define` 注入值（开发态 Token 与 sidecar 基址）。 */
declare const __ATB_UI_TOKEN__: string;
declare const __ATB_API_BASE__: string;

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_ATB_API_BASE?: string;
  readonly VITE_ATB_UI_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Tauri 主进程通过 initialization_script 注入的运行期入口（PRD 9.4.1 第 5 步）。 */
interface Window {
  __ATB_UI_TOKEN__?: string;
  __ATB_API_BASE__?: string;
  __ATB_PORT__?: number | string;
  __TAURI__?: {
    core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    window?: Record<string, unknown>;
  };
}
