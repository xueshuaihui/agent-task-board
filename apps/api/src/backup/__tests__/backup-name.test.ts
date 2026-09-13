import { describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import {
  BACKUP_NAME_RE,
  EXPORT_NAME_RE,
  assertBackupName,
  backupNameAt,
  exportNameAt,
  isBackupName,
  localStamp,
} from '../backup-name';

/**
 * 15 章的硬约束落在这一小段代码上：`{name}` 是**唯一**参与服务端路径组装的入参，
 * 所以它必须先过白名单再去 join。文件名形状同时决定 9.3 的列表能否扫得回来。
 */

function expectRejected(name: unknown, message: string): ApiException {
  const error = (() => {
    try {
      assertBackupName(name as string);
      return new Error('本该抛错，却通过了校验');
    } catch (thrown) {
      return thrown;
    }
  })();
  expect(error).toBeInstanceOf(ApiException);
  const api = error as ApiException;
  expect(api.code).toBe('INVALID_BACKUP_NAME');
  expect(api.status).toBe(400);
  expect(api.toBody().error).toMatchObject({ code: 'INVALID_BACKUP_NAME', message });
  return api;
}

describe('备份 / 导出文件名形状', () => {
  it('文件名用本地时间的秒级戳，补齐两位', () => {
    // 用本地分量构造，断言与宿主时区无关
    const date = new Date(2026, 8, 1, 5, 6, 7);
    expect(localStamp(date)).toBe('20260901-050607');
    expect(backupNameAt(date)).toBe('atb-20260901-050607.db');
    expect(exportNameAt(date)).toBe('atb-export-20260901-050607.json');
    expect(isBackupName(backupNameAt(date))).toBe(true);
    expect(isBackupName(backupNameAt())).toBe(true);
  });

  it('当前生成的名字确实落在本地钟点上，而不是 toISOString 的 UTC', () => {
    const now = new Date();
    expect(localStamp(now)).toBe(
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
        `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`,
    );
  });

  it('正则就是 13 章写死的那一条：atb-YYYYMMDD-HHmmss.db', () => {
    expect(BACKUP_NAME_RE.source).toBe('^atb-\\d{8}-\\d{6}\\.db$');
    expect(EXPORT_NAME_RE.source).toBe('^atb-export-\\d{8}-\\d{6}\\.json$');
    expect('atb-20260901-050607.db').toMatch(/^atb-\d{8}-\d{6}\.db$/);
  });

  it('合法名字原样返回，供调用方直接拼路径', () => {
    expect(assertBackupName('atb-20260901-050607.db')).toBe('atb-20260901-050607.db');
  });
});

describe('INVALID_BACKUP_NAME：四类拒绝各有说法', () => {
  it('空与非字符串先挡', () => {
    expectRejected('', '备份文件名不能为空');
    expectRejected(undefined, '备份文件名不能为空');
    expectRejected(null, '备份文件名不能为空');
    expectRejected(42, '备份文件名不能为空');
  });

  it('带路径分隔符与 .. 的名字一律 400，而不是拿去拼路径后 404', () => {
    for (const name of [
      '../atb-20260901-050607.db',
      '../../atb-20260901-050607.db',
      '../backups/atb-20260901-050607.db',
      'sub/atb-20260901-050607.db',
      'atb-20260901-050607.db/..',
      '..\\atb-20260901-050607.db',
      '/absolute/atb-20260901-050607.db',
      '/etc/passwd',
      'C:\\atb-20260901-050607.db',
    ]) {
      expectRejected(name, '备份文件名不能包含路径分隔符');
      expect(isBackupName(name)).toBe(false);
    }
  });

  it('形状不对只报正则那一条', () => {
    for (const name of [
      'atb.db',
      'atb-20260901-050607.sql',
      'atb-20260901-050607.db.bak',
      'atb-2026901-050607.db',
      'atb-20260901-05067.db',
      'atb-2026091-050607.db',
      'atb-2026-09-01-050607.db',
      'atb-20260901-050607.DB',
      'backup-20260901-050607.db',
      'atb -20260901-050607.db',
      'atb-20260901_050607.db',
      'atb-202609010506 07.db',
      '\u0000atb-20260901-050607.db',
    ]) {
      expectRejected(name, '备份文件名需匹配 atb-YYYYMMDD-HHmmss.db');
    }
  });

  it('导出名的形状不与备份名混用', () => {
    expect(isBackupName('atb-export-20260901-050607.json')).toBe(false);
    expect(EXPORT_NAME_RE.test('atb-20260901-050607.db')).toBe(false);
    expectRejected('atb-export-20260901-050607.json', '备份文件名需匹配 atb-YYYYMMDD-HHmmss.db');
  });
});
