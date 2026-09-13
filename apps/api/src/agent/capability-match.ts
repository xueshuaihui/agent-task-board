/** 20.5 能力匹配四步法里的「子集判定」一步，claim 与 list 必须共用，否则会出现看得见领不到。 */

/** 入参 capabilities 非空时覆盖 Token 声明；缺省即用 Token 上的能力集合。 */
export function effectiveCapabilities(
  declared: string[] | undefined,
  tokenCapabilities: string[],
): string[] {
  return declared && declared.length > 0 ? declared : tokenCapabilities;
}

/** 任务声明的能力是最低要求：`required ⊆ effective`，空 required 对任何 Token 可见。 */
export function capabilitiesCovered(required: string[], effective: Set<string>): boolean {
  if (required.length === 0) return true;
  for (const capability of required) {
    if (!effective.has(capability)) return false;
  }
  return true;
}

/** 入参 task_types 为空表示不限。 */
export function taskTypeAllowed(type: string, taskTypes: string[]): boolean {
  return taskTypes.length === 0 || taskTypes.includes(type);
}
