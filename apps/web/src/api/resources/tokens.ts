import { http } from '../client';
import type { AgentToken, IssuedToken, TokenCreateInput } from '../types';

/** 13 章「Token / 设置接口」：Token 只在设置页出现（8.5）。 */
export const tokensApi = {
  /** 列表含已吊销项（`enabled = false`），供界面渲染「已吊销」态。 */
  list: () => http.get<{ items: AgentToken[] }>('/tokens'),
  /** 响应含一次性明文 `token`（服务端只存 hash），界面必须提示「只显示这一次」。 */
  create: (body: TokenCreateInput) => http.post<IssuedToken>('/tokens', body),
  /** 吊销 = 置 `enabled = 0`、不删行（`task_runs.token_id` 要保归属），且无反向接口。 */
  revoke: (id: string) => http.del<{ id: string; enabled: false }>(`/tokens/${enc(id)}`),
};

function enc(value: string): string {
  return encodeURIComponent(value);
}
