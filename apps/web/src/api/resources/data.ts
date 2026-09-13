import { http } from '../client';
import type { ExportInput, ImportPreview, ImportStrategy } from '../types';

/**
 * 6.12.1 / 6.12.2 数据接口。
 * 导出是附件流（`atb-export-YYYYMMDD-HHmmss.json`），`http.download` 返回 Blob + 文件名；
 * 导入是 multipart + `dry_run` 预览。
 * 归档列表**没有**独立端点：唯一读路径是 `GET /tasks?archived=true`（13 章）。
 */
export const dataApi = {
  export: (body: ExportInput) => http.download('POST', '/data/export', { body }),
  /** `dry_run=true` 只校验与统计冲突、不写库——导入界面的「预览」即此调用。 */
  importPreview: (file: File) => importRequest(file, 'skip', true),
  /** 确认按钮才带 `dry_run=false`。 */
  importApply: (file: File, strategy: ImportStrategy) => importRequest(file, strategy, false),
};

function importRequest(file: File, strategy: ImportStrategy, dryRun: boolean) {
  const form = new FormData();
  form.append('file', file);
  form.append('strategy', strategy);
  form.append('dry_run', dryRun ? 'true' : 'false');
  return http.form<ImportPreview>('/data/import', form);
}
