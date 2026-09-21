import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import type { RequestAuth } from '../auth/auth.scope';
import { agentOf } from './agent-auth';
import type {
  CheckMcpPolicyInput,
  ReportMcpCallInput,
} from '../contract/agent-schemas';
import type { SkillMcpDependency } from '../skills/skills.dto';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';

/** §12.4 裁决形态：策略包随技能下发，这里按技能当前声明现算，不另存一份策略。 */
export interface McpPolicyDecision {
  skill_id: string;
  server: string;
  tool: string;
  allowed: boolean;
  decision: 'allow' | 'deny';
  /** deny 时给 Agent 可操作的原因；allow 时说明命中的声明。 */
  reason: string;
  /** 命中的依赖声明是否 required（§12.5：true 时缺失应中止并 block_task）。未命中为 true（保守）。 */
  required: boolean;
}

/**
 * v0.0.4 W6 §12.6：MCP 治理的两个数据面工具（check_mcp_policy / report_mcp_call）的落点。
 * 平台不代理 Agent 对第三方 MCP 的调用，审计来源就是这两次上报——
 * check 落「策略决策记录」、report 落「调用结果」，均写入通用 `audit_logs`（无新表）。
 */
@Injectable()
export class McpPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 调用前策略裁决：技能不存在 404；未声明服务器/工具一律拒（deny_undeclared，§12.4）。 */
  async check(input: CheckMcpPolicyInput, auth: RequestAuth): Promise<McpPolicyDecision> {
    const agent = agentOf(auth);
    const skill = await this.prisma.skill.findUnique({ where: { id: input.skill_id } });
    if (!skill) {
      throw new ApiException('NOT_FOUND', '技能不存在', undefined, { skill_id: input.skill_id });
    }
    const deps = parseDependencies(skill.mcpDependencies);
    const declared = deps.find((dep) => dep.server === input.server);
    const base = { skill_id: input.skill_id, server: input.server, tool: input.tool };
    let decision: McpPolicyDecision;
    if (!declared) {
      decision = {
        ...base,
        allowed: false,
        decision: 'deny',
        required: true,
        reason: `技能未声明 MCP 服务器「${input.server}」：deny_undeclared（§12.4）`,
      };
    } else if (!declared.tools.includes(input.tool)) {
      decision = {
        ...base,
        allowed: false,
        decision: 'deny',
        required: declared.required,
        reason: `服务器「${input.server}」的声明未包含工具「${input.tool}」：tools 必须精确到工具级（§12.2）`,
      };
    } else {
      decision = {
        ...base,
        allowed: true,
        decision: 'allow',
        required: declared.required,
        reason: `命中的声明：${input.server}.${input.tool}（required=${declared.required}）`,
      };
    }
    await this.audit.record({
      actorType: 'agent',
      actorName: agent.tokenName,
      action: 'mcp_policy_check',
      targetType: 'mcp',
      targetId: input.skill_id,
      // §12.6「调用发起」三要素（skill/task/run）随入参原样进审计，后接裁决。
      after: {
        ...input,
        allowed: decision.allowed,
        decision: decision.decision,
        reason: decision.reason,
        required: decision.required,
      },
    });
    return decision;
  }

  /** 调用后结果上报：只落审计（§12.6 的耗时/成败/策略决策三列），不回查任何外键。 */
  async report(input: ReportMcpCallInput, auth: RequestAuth): Promise<{ recorded: true }> {
    const agent = agentOf(auth);
    await this.audit.record({
      actorType: 'agent',
      actorName: agent.tokenName,
      action: 'mcp_call',
      targetType: 'mcp',
      targetId: input.skill_id ?? input.server,
      after: input,
    });
    return { recorded: true };
  }
}

function parseDependencies(raw: string): SkillMcpDependency[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SkillMcpDependency[]) : [];
  } catch {
    return [];
  }
}
