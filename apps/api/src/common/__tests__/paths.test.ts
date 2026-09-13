import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PORT, port } from '../paths';

/**
 * 10.3 / 20.9：端口由 `ATB_PORT` → `config.json` 的 `port` → 7788 三级决定，
 * 不进 `settings`。主进程与 sidecar 各有一份解析（`paths.rs::resolve_port`），
 * 这里锁住 sidecar 这份的优先级与「坏配置不阻断启动」。
 */
describe('port() 三级解析', () => {
  let dir: string;
  const env = { ATB_PORT: process.env.ATB_PORT, ATB_DATA_DIR: process.env.ATB_DATA_DIR };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'atb-port-'));
    process.env.ATB_DATA_DIR = dir;
    delete process.env.ATB_PORT;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (body: string) => writeFileSync(path.join(dir, 'config.json'), body, 'utf8');

  it('没有任何一级配置时回落默认端口', () => {
    expect(port()).toBe(DEFAULT_PORT);
  });

  it('config.json 的 port 覆盖默认值', () => {
    writeConfig(JSON.stringify({ port: 7911 }));
    expect(port()).toBe(7911);
  });

  it('ATB_PORT 优先于 config.json', () => {
    writeConfig(JSON.stringify({ port: 7911 }));
    process.env.ATB_PORT = '7912';
    expect(port()).toBe(7912);
  });

  it.each(['0', '70000', 'abc', '', '  '])('ATB_PORT=%p 非法时按下一级解析', (raw) => {
    writeConfig(JSON.stringify({ port: 7911 }));
    process.env.ATB_PORT = raw;
    expect(port()).toBe(7911);
  });

  it.each([
    ['缺文件', null],
    ['不是 JSON', 'not json'],
    ['顶层不是对象', '[1,2]'],
    ['port 缺失', '{}'],
    ['port 是字符串', '{"port":"7911"}'],
    ['port 越界', '{"port":70000}'],
    ['port 为 0', '{"port":0}'],
  ])('config.json %s 时不抛错，回落 %p', (_label, body) => {
    if (body !== null) writeConfig(body);
    expect(port()).toBe(DEFAULT_PORT);
  });

  it('只读不写：未知键保留，文件字节不变（写回是主进程 persist_port 的事）', () => {
    const file = path.join(dir, 'config.json');
    const body = JSON.stringify({ port: 7911, theme: 'dark' });
    writeFileSync(file, body, 'utf8');
    expect(port()).toBe(7911);
    expect(readFileSync(file, 'utf8')).toBe(body);
  });
});
