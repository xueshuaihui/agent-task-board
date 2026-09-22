
# edu-agent

> ⏱️ **重要：本 skill 为长任务，单次调用最长可达 30 分钟**
>
> 调用方（含 openclaw / 上层 LLM agent）**必须**遵守：
> - 单次调用最长允许执行 **1800 秒（30 分钟）**，请勿用 5 分钟硬超时杀进程
> - 等待期间会持续通过 `report_steps` 上报中间状态，这就是"还在干活"的信号
> - **长时间无最终 JSON 输出 ≠ 失败**，请勿中途打断、kill 子进程或重新发起
> - 仅当 ① 进程明确退出且 `ok: false`，或 ② 连续 5 分钟没有任何 `report_steps` 上报，才判定为异常
> - 如果你的运行时（subprocess / asyncio.wait_for / k8s Job）有默认超时，请把它调到 ≥ 1800s
>
> 背景：本 skill 内部走 SSE 流式调用 edu-agentscope，涉及多轮大模型推理 + 沙箱工具执行（搜题/找卷/写文件/HTML 课件生成等），正常耗时区间 3–15 分钟，复杂场景可能达到 25 分钟。过去出现过外层调度器在 5 分 1 秒 SIGTERM 子进程、导致代理侧 Broken pipe 的事故，请勿重犯。




## 补全信息

### 通用补全原则

- 推断用户query对应的意图，调用`call_edu_agent.py` 时显示的告知意图 如: souti_new
- 再从用户 query 中推断所需信息，在保证准确的情况下尽量补全，再调用 `call_edu_agent.py`
- **补全字段**（学科、章节、知识点、年级、学段、地域、试卷类型、难度、题型等）：可从 query和用户信息推断则补全；缺失、不确定或无法推断时不用强行补全，保证信息的准确性，直接调用 `call_edu_agent.py`，不必阻塞等待用户

### 按意图类型的补全规则

#### 题目检索 souti_new

- 用于用户找题目、出题目、题目检索的需求，如：出一套人教版七年级上册5道函数题
- 不在本SKILL的服务范畴内的意图如下，以下意图不应该调用call_edu_agent.py：

  1. **题目解答** → 不提供解题、题目分析、讲解题目能力。

  2. **听力/口语题目** → 不具备音频播放、语音识别、发音评测或口语对话能力。

  3. **非K12范围** → 服务仅限小学、初中、高中。不提供大学、考研、留学考试（GRE/GMAT/TOEFL/IELTS等）、职业教育或技能鉴定等需求。

  4. **少量题目需求** → 少量题目（1~2题）检索、找题目、出题目需求不用在该skill承接。


| 字段 | 处理规则 |
|------|----------|
| 学科 | 从 query 语义推断（如"一元二次方程"→数学）；缺失可直接调用 |
| 年级/学段 | 从 query 推断；缺失可直接调用 |
| 知识点/题型/难度 | 知识点从 query 提取，缺失且无法推断则询问用户；题型/难度从 query 提取，缺失可直接调用 |



## 调用方式

**始终使用 bundled 脚本**，不要自己拼 MCP 请求。脚本内部通过 `ctx.mcp.call_tool()` 走 IPC 到 MCP 网关。

```bash
# 单轮对话
python /app/skills/edu-agent/scripts/call_edu_agent.py \
  --message "请先调用工具读取souti_new 在完成下面任务：出几道一元二次方程的题目 " \
  --session-id "<uuid>"

# 复用 session 实现多轮
python /app/skills/edu-agent/scripts/call_edu_agent.py \
  --message "请先调用工具读取souti_new 在完成下面任务：再来几道题目" \
  --session-id "<uuid>"
```

脚本输入message、session-id必填，脚本输出 JSON 到 stdout，结构：

```json
{
  "ok": true,
  "session_id": "...",
  "text": "助手完整回复",
  "raw_events_count": 42
}
```

失败时 `ok: false`，`error` 字段含原因。

## 工作流

```
用户教育类请求
    ↓
call_edu_agent.py --message "..."
    ↓
解析 JSON：将 text 作为最终回答回复用户
    ↓
多轮：同一 session_id 再次调用
```

### 向用户呈现结果

- 将 `text` 作为最终回答直接呈现给用户。
- 若 `ok: false`，说明服务未启动或请求失败，并给出启动命令；可尝试用本地能力降级处理。

## 超时与中断处理

| 场景 | 正确做法 | 错误做法 |
|------|---------|---------|
| 调用 5 分钟还没返回 | 继续等，观察 `report_steps` | ❌ 直接 kill 进程并报错 |
| 调用 15 分钟仍在跑 | 继续等到 30 分钟上限 | ❌ 重新发起请求 |
| 看到 `Broken pipe` / `ClientAbortException` 在代理日志 | **是调用方过早断连导致**，本侧无 bug | ❌ 当成上游故障上报 |
| 30 分钟整仍未返回 | 判定为真异常，可中止并报错 | — |

如果你（调用方 LLM 或 runner）必须设置超时，请使用 `1800` 秒，**不要使用 300 / 600 等较短值**。

## 兜底逻辑

- 如果 call_edu_agent.py 的结果失败或者未满足用户需求，可以尝试其他skills解决问题，最终回复不要提及本skill执行失败的相关信息。。