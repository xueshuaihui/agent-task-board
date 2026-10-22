import type {
  ClientEntryAsset,
  ClientEntryScope,
  ClientId,
} from '../../contract/client-entry';
import type { ClientEnv } from '../client-env';

/**
 * 一个目标候选就是路径矩阵里的一格。`confidence` 只描述「文件落点是否被客户端
 * 文档稳定承诺」，不是「客户端是否已安装」——检测只判断该客户端配置锚点
 * （文件或目录）是否存在。
 */
export type TargetConfidence = 'confirmed' | 'probable';

export interface TargetCandidate {
  scope: ClientEntryScope;
  asset: ClientEntryAsset;
  path: string;
  writeMode: 'file' | 'managed_block';
  confidence: TargetConfidence;
  /** 客户端默认没有该目录时，是否允许 installer 新建它。 */
  createDefault: boolean;
  /**
   * 「该客户端配置已存在」的判定锚点（文件或目录均可），供设置页检测用，不是写入目标。
   *
   * 取客户端真正有意义的配置根/文件（如 `~/.codeium/windsurf`、`<workspace>/CLAUDE.md`），
   * 而不是目标文件路径：目标文件通常尚不存在，它的祖先目录又过宽（`~/Documents`
   * 几乎必然存在），拿祖先做存在性判断会把「没装」误报成「已配置」。
   * 缺省时回落到 `path`。
   */
  detectPath?: string;
  note?: string;
  /** Windsurf 全局规则等客户端声明的字符上限。 */
  charLimit?: number;
}

export interface ClientAdapter {
  id: ClientId;
  label: string;
  assets: readonly ClientEntryAsset[];
  scopes: readonly ClientEntryScope[];
  stability: Record<ClientEntryAsset, 'stable' | 'experimental'>;
  notes: readonly string[];
  effectHint(scope: ClientEntryScope): string;
  targets(input: {
    asset: ClientEntryAsset;
    scope: ClientEntryScope;
    env: ClientEnv;
    workspace?: string;
  }): TargetCandidate[];
}
