import { isDev } from './paths';

/**
 * 9.4.3：Origin 精确匹配，不回显任意来源、不接受 `Origin: null`、不按端口段放行。
 * 生产只有 WebView 的两个源；开发模式额外放行 Vite dev server——它同样是精确值，
 * 且只在 ATB_DEV=1 / NODE_ENV=development 时存在。
 */
const PROD_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'];
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function allowedOrigins(): string[] {
  const fromEnv = (process.env.ATB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const base = isDev() ? [...PROD_ORIGINS, ...DEV_ORIGINS] : PROD_ORIGINS;
  return [...new Set([...base, ...fromEnv])];
}
