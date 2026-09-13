import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 与 apps/api/src/common/paths.ts 同源的一份 dataDir / port 解析。
 * 不 import 后端代码：前端构建不该依赖 Nest 的编译产物，两处逻辑各自有注释互指。
 */
function resolveDataDir(): string {
  const fromEnv = process.env.ATB_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'agent-board');
  }
  return path.join(os.homedir(), '.agent-board');
}

function resolveApiPort(): number {
  const parsed = Number(process.env.ATB_PORT ?? '7788');
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 7788;
}

/**
 * 9.4.1：生产下 UI 会话 Token 由 Tauri 主进程注入 WebView（window.__ATB_UI_TOKEN__）。
 * 开发态没有主进程，sidecar 在 ATB_DEV=1 时把同一个 Token 落到 <dataDir>/dev-ui-token（0600），
 * 这里在构建期读出来注入，等价于「本机当前登录用户可读」，不进查询参数也不落前端产物。
 */
function readDevUiToken(): string {
  const file = path.join(resolveDataDir(), 'dev-ui-token');
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return raw.length >= 32 ? raw : '';
  } catch {
    return '';
  }
}

const apiPort = resolveApiPort();
const apiBase = process.env.ATB_API_BASE ?? `http://127.0.0.1:${apiPort}`;
const devToken = readDevUiToken();

if (!devToken) {
  console.warn(
    `[atb/web] 未读到 ${path.join(resolveDataDir(), 'dev-ui-token')}：` +
      '先用 `ATB_DEV=1 ATB_DATA_DIR=... npm run dev:api` 起 sidecar 再重启 vite，否则所有请求 401。',
  );
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(process.cwd(), 'src') },
  },
  define: {
    __ATB_UI_TOKEN__: JSON.stringify(devToken),
    __ATB_API_BASE__: JSON.stringify(apiBase),
  },
  server: {
    // 5173 是被 sidecar 精确放行的两个源之一（apps/api/src/common/origins.ts），端口不可漂。
    port: 5173,
    strictPort: true,
    host: 'localhost',
    // 不配 proxy：直连 127.0.0.1:7788 才走得通 sidecar 的精确 Origin 白名单，
    // 代理会把请求伪装成同源，CORS 回归就测不出来了（9.4.3）。
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
