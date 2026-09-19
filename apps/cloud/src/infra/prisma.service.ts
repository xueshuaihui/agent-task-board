import { PrismaClient } from '../../prisma/generated/client';
import { paths } from '../common/paths';

/** 连接参数见 common/paths.ts：WAL + busy_timeout + 单写连接。 */
export class PrismaService extends PrismaClient {
  constructor() {
    super({
      datasourceUrl: paths.datasourceUrl(),
      log: process.env.CLOUD_SQL_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
}
