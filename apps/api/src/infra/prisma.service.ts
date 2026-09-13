import { PrismaClient } from '@prisma/client';
import { paths } from '../common/paths';

/**
 * 连接串上的三个 pragma 是认领并发的前提：
 * - `connection_limit=1`：SQLite 单写者，把所有写请求收敛到一条连接上，
 *   认领的「选候选 → 占位」两步之间不会有本进程的第二个写者插队；
 * - `journal_mode=WAL`：写事务不阻塞看板读取；
 * - `busy_timeout`：外部进程（备份、CLI）短暂持锁时不立刻报错。
 */
export class PrismaService extends PrismaClient {
  constructor() {
    super({
      datasourceUrl: paths.datasourceUrl(),
      log: process.env.ATB_SQL_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
}
