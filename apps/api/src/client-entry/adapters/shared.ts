import fs from 'node:fs';

/**
 * adapter 只做「探测 + 拼路径」，所有探测失败一律当作「不存在」：
 * 没有权限读取某个候选目录，不应该让整张客户端列表 500。
 */
export function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 项目级必须由用户显式选目录；空串/纯空白视作没选。 */
export function requireWorkspace(workspace: string | undefined): string | undefined {
  return workspace && workspace.trim() !== '' ? workspace : undefined;
}
