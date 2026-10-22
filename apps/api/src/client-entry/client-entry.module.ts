import { Module } from '@nestjs/common';
import { ClientEntryController } from './client-entry.controller';
import { ClientEntryRepository } from './client-entry.repository';
import { ClientEntryService } from './client-entry.service';
import { WakeProbeService } from './wake-probe.service';

/**
 * 设置 → 客户端入口。`InfraModule` 是 @Global，Prisma/Audit/Settings 直接注入。
 * `WakeProbeService` 导出给切片 D 的 McpModule（`wake_probe` 工具落库），
 * 避免 MCP 侧另开一份写入实现与裁剪逻辑。
 */
@Module({
  controllers: [ClientEntryController],
  providers: [ClientEntryService, ClientEntryRepository, WakeProbeService],
  exports: [WakeProbeService],
})
export class ClientEntryModule {}
