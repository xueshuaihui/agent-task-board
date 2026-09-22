# 公文写作

## Purpose

Generate or revise Chinese official documents that are structurally correct, usable as a deliverable, fact-grounded, restrained in tone, and low in AI-flavored boilerplate. Combine two source bases:

- Formal public-document writing rules: document-type choice, official format, upward/downward/parallel writing, closing formulas, and common format errors.
- People's Daily-style expression distillation: fact density, restrained judgment, functional paragraphs, natural progression, abstract-word control, and resistance to empty slogans.
- Humanizer-style cleanup rules: significance inflation, fake depth, vague actors, rule-of-three packaging, synonym cycling, meta-commentary, formulaic conclusions, and over-polished cadence.

## Core Workflow

1. Identify the scenario: issuer, recipient, relationship (上行/下行/平行/面向公众), purpose, audience, urgency, required length, and whether a formal red-head shell is needed.
2. Choose the document type. If the user's requested type conflicts with purpose or relationship, quietly correct it in the draft or briefly flag the mismatch.
3. Extract facts before drafting: subject, object, action, mechanism, data, time, place, problem, result, responsibility, deadline, feedback path, and policy basis.
4. Build a document skeleton by type. Do not force every task into a publicity article, speech, or three-part slogan structure.
5. Draft with official restraint: facts and tasks first, then necessary judgment. Use long sentences for background, mechanisms, and compound facts; use short sentences for decisions, reminders, and closing.
6. Run the anti-AI pass: check fact density, judgment strength, sentence rhythm, abstract-word control, paragraph function, type fit, and grounded ending.
7. Run the humanizer pass: ask "What still makes this look AI-written?" Remove clustered tells such as meaning inflation, fake depth, meta signposting, rule-of-three packaging, synonym cycling, vague attribution, generic positive conclusions, and overly tidy cadence.
8. Score internally using the rubric below. If below 80, rewrite or compress hollow paragraphs before final output.
9. Deliver the final document first. Add a short "需补充信息" list only when placeholders remain or missing facts materially affect use.

## Output Defaults

- Use Chinese unless the user requests another language.
- Produce a complete usable draft, not only an outline, when enough facts exist.
- If key facts are missing, use a small number of bracketed placeholders such as `〔发文机关〕` or `〔日期〕`.
- For formal official drafts, include title, main recipient, body, issuing unit, and date when applicable. Include 发文字号、附件、抄送、版记 only if requested or supplied.
- For exam/application-writing prompts, obey the word limit and omit formal elements only when the prompt says "不必考虑格式".
- Never invent laws, documents, meetings, leader names, numbers, departments, budgets, dates, outcomes, or approvals.
- Do not leave chatbot artifacts in the deliverable, such as `当然可以`, `下面是`, `希望这能帮到你`, `如需我继续`, or explanations of what the assistant is about to do.

## Document-Type Decision

### Formal Official Documents

| 文种 | 适用场景 | Key Structure | Required Discipline |
| --- | --- | --- | --- |
| 通知 | 下行或平行告知办理、执行、周知事项 | 依据/背景 + 事项 + 要求 + 时限 | 明确对象、事项、责任；平行通知避免命令口吻 |
| 通报 | 表彰先进、批评错误、传达重要情况 | 事实 + 评价/原因 + 决定/要求 | 事实准确，评价克制，避免情绪化 |
| 报告 | 向上级汇报工作、反映情况、答复询问 | 情况 + 做法 + 成效 + 问题 + 下一步 | 不夹带请示事项；可用"特此报告" |
| 请示 | 向上级请求指示、批准、批转 | 缘由 + 依据/困难 + 请求事项 + 请求语 | 一文一事，一般只送一个主送机关；"妥否，请批示/批复" |
| 批复 | 答复下级请示 | 引述来文 + 批复意见 + 要求 | 明确同意/不同意及依据，不含糊 |
| 函 | 不相隶属机关商洽、询问、答复、请求批准 | 来由 + 事项 + 希望/回复 | 语气平等、礼貌；"特此函告/函复""盼复" |
| 纪要 | 记载会议主要情况和议定事项 | 会议概况 + 议定事项 + 落实要求 | 写"会议认为/指出/要求"，不写流水账 |
| 决定 | 对重要事项作出安排、奖惩或变更 | 依据/事实 + 决定事项 + 执行要求 | 权威、明确，适合较重大事项 |
| 通告 | 在一定范围公布应遵守或周知事项 | 依据 + 通告事项 + 生效/执行要求 | 面向社会或特定范围，条款清楚 |
| 公告 | 向国内外宣布重要事项或法定事项 | 事项 + 说明 | 级别和事项通常较高，慎用 |
| 意见 | 对重要问题提出见解和处理办法 | 背景意义 + 总体要求 + 具体意见 | 政策性较强，可上行、下行、平行 |
| 议案 | 政府向人大或人大常委会提请审议 | 案由 + 方案/依据 + 提请审议 | 注意法定主体和程序 |

### Practical Government Writing

| 文体 | 适用场景 | Writing Focus |
| --- | --- | --- |
| 工作方案 | 安排专项行动、活动、治理任务 | 目标要求、重点任务、实施步骤、责任分工、保障措施 |
| 工作计划 | 对未来阶段工作作安排 | 目标、重点任务、时间节点、保障措施；少写成绩，多写安排 |
| 工作总结 | 回顾阶段工作 | 总体情况、主要做法、成效经验、问题不足、下步安排 |
| 简报/信息稿 | 内部快速反映情况、经验、动态 | 导语、主要做法、阶段成效、经验启示；短、实、新 |
| 讲话稿/发言稿 | 会议、活动、座谈发言 | 称谓、开场、形势认识、重点任务、落实要求、收束 |
| 表态发言 | 表达态度和落实承诺 | 认识、态度、措施、承诺；每个表态接具体动作 |
| 汇报材料 | 向领导或会议汇报 | 背景、进展、成效、问题、建议/下一步；突出可决策信息 |
| 调研报告 | 反映调查研究结果 | 调研背景、现状、问题原因、对策建议；建议与问题对应 |
| 倡议书 | 面向群体发起行动 | 背景意义、倡议事项、号召；热情但不空泛 |
| 宣传稿 | 面向公众宣传政策、活动、典型 | 场景切入、典型事实、做法成效、适度升华 |
| 公开信 | 面向特定群体公开沟通 | 称谓明确，先共情/说明，再提出事项，结尾表达期待 |
| 感谢信 | 表达感谢和表扬 | 具体事迹、影响意义、感谢敬意；避免泛泛而谈 |
| 信访回复 | 答复群众诉求 | 受理情况、调查核实、处理意见、救济渠道/联系方式 |
| 理论评论 | 阐释观点、回应问题 | 问题、判断、论证、事实、价值收束；不要反套到普通公文 |
| 政策解读 | 说明政策内容和执行口径 | 政策依据、核心变化、适用对象、办理流程、问答提示 |

### Easy Confusions

- 请示 vs 报告: 有请求批准就是请示；只汇报情况就是报告。报告不得夹带"请予批准"。
- 批复 vs 复函: 有隶属关系、答复下级请示用批复；不相隶属单位之间答复用函。
- 通知 vs 通告: 内部或特定单位办理周知多用通知；面向社会公开遵守事项多用通告。
- 纪要 vs 会议记录: 纪要提炼议定事项并可用于执行；会议记录是原始过程材料。
- 方案 vs 计划: 方案重"如何组织实施专项任务"；计划重"未来一段时间做什么"。

## Formal Format Rules

### Title

- Common structure: `发文机关 + 关于 + 事由 + 的 + 文种`, such as `XX市人民政府关于开展安全生产专项整治的通知`.
- Use `关于 + 事由 + 的 + 文种` when the issuer is unknown or a simplified draft is requested.
- Avoid semantic repetition: do not write `关于请求批准……的请示`; do not write a 函 as a command.
- The title should identify the matter and document type. Do not replace a document title with a slogan.

### Main Recipient

- Write the main recipient flush left with a colon.
- A 请示 generally has only one main recipient; use 抄送 for other necessary units.
- Use 顿号 between same-level same-category organs; use 逗号 between different categories.
- For public-facing practical writing, use audience labels such as `广大市民朋友们：`.

### Body

- Opening: explain basis, background, purpose, problem, or incoming document. Do not start with unrelated grand meaning.
- Main part: arrange matters in a list when execution is needed. Clarify object, task, standard, deadline, responsible unit, and feedback.
- Closing by type: 请示 uses `妥否，请批示/批复`; 函 uses `特此函告/函复` or `盼复`; 通知 uses implementation requirements; 报告 may use `特此报告`.
- Keep one document to one main matter, especially for 请示、函、批复.

### Attachments, Signature, Date

- If attachments are mentioned, list them as `附件：1. XXX`; attachment names usually do not end with punctuation.
- Issuing unit and date usually align to the right. A normal date may be `2026年6月10日`.
- Formal documents may require unit-specific layout, seal rules, red-head page setup, and版记. Do not simulate unavailable seals or file numbers.
- The date should match the signing/issuing logic; do not invent it.

### Writing Relationship

- 上行文: 请示、报告. Be factual and respectful; do not decide for the superior.
- 下行文: 通知、通报、决定、批复. Be clear about requirements, responsibility, and deadlines.
- 平行文: 函. Use equal, consultative language; do not issue commands.

### Common Format Errors

- A report includes a hidden request for approval.
- A request has multiple main recipients or multiple matters.
- The title document type conflicts with the body purpose.
- The main recipient is missing or mismatched.
- An attachment is mentioned but not listed.
- Date, issuing unit, and title are inconsistent.
- `相关部门` or `各单位` is used where a responsible subject must be clear.

## People's Daily-Inspired Expression Patterns

Use these patterns as expression discipline, not as decorative imitation. Do not transfer commentary style into a routine notice or request.

### High-Frequency Structure Patterns

- Background-introduction pattern: reality/policy background -> object explanation -> basic judgment -> facts -> lesson. Suitable for reports, summaries, research reports, speech openings. Risk: background too large and detached from the unit's work.
- Problem-entry pattern: problem or shortcoming -> cause breakdown -> facts -> direction. Suitable for research reports,整改 reports, special reports. Risk: saying only "坚持问题导向" without a real problem.
- Achievement-summary pattern: work foundation -> main practices -> stage results -> experience -> next steps. Suitable for summaries, reports, briefings. Risk: stronger judgment than evidence.
- Policy-interpretation pattern: policy basis -> core requirements -> task breakdown -> implementation safeguards. Suitable for schemes, implementation opinions, notice attachments. Risk: rearranging policy words without turning them into local tasks.
- Action-deployment pattern: situation judgment -> objectives -> key measures -> responsibility mechanism -> deadline. Suitable for方案、通知、会议部署. Risk: continuous `要……` with verbs that have no object.
- Value-elevation pattern: typical fact -> value judgment -> broader significance -> outlook. Suitable for publicity articles and speech endings only in moderation. Risk: oversized ending in ordinary official writing.

### Logic Progression Rules

- From background to problem: use changes in a real work scene, not vague "complex situation".
- From problem to measure: write the problem manifestation first, then the matching action.
- From achievement to experience: write what was completed before summarizing the practice formed.
- From deployment to implementation: after the objective, write responsible subject, process node, deadline, and feedback.
- From macro judgment to local work: every macro word must connect to this unit, field, or task.
- From case to general rule: give the typical object, extract the mechanism, then state the boundary.
- Prefer factual order and work-process progression over dense connectors such as `不仅……而且……` or `一方面……另一方面……`.

### Paragraph Function

Every paragraph must have one primary function: background, problem, basis, measure, result, responsibility, deadline, safeguard, or closing. Do not stack several paragraphs that only explain significance.

Useful paragraph roles:

- Background paragraph: sets the boundary of the task.
- Problem paragraph: identifies object, link, impact.
- Measure paragraph: names the subject, action, method, and result.
- Responsibility paragraph: names牵头单位、配合单位、反馈方式、检查节点.
- Closing paragraph: returns to办理要求、执行提醒、报送节点、工作目标.

## Anti-AI Style Standard

### Fact Density

Common AI problem: a paragraph has only meaning, attitude, and slogans, with no object, action, mechanism, or data.

Rule: after deleting adjectives and four-character slogans, the paragraph should still answer: who does what, how, and to what extent.

Prefer:

- `我单位将办事材料由〔数量〕项压减至〔数量〕项，新增线上预审入口，减少群众现场补交材料次数。`

Avoid:

- `我单位持续优化服务能力，推动工作提质增效。`

### Judgment Strength

Match the evaluation word to evidence strength:

| Level | Expression | Use Condition |
| --- | --- | --- |
| 1 | 已启动、正在开展 | Only deployment or initial action exists |
| 2 | 有序推进、稳步推进 | Planned steps exist, results limited |
| 3 | 取得进展、初见成效 | Stage results or audience feedback exists |
| 4 | 取得明显成效、形成机制 | Data,制度、流程, or stable operation exists |
| 5 | 重大突破、历史性成就 | Authoritative recognition, key indicators, industry comparison, or historic node exists |

When evidence is weak, downgrade the judgment. 宁可稳妥，不要拔高.

### Sentence Rhythm

- Avoid continuous `要……要……要……`.
- Avoid overusing `不仅……而且……`, `既是……也是……`, `一方面……另一方面……`.
- Avoid every paragraph using the same pattern.
- Use long sentences for facts, basis, processes, and compound conditions; use short sentences for decisions and reminders; use bullet/numbered lists for measures.

### Abstract-Word Control

Abstract words are allowed only when followed by concrete content.

| Term | Use When | Do Not Use When | Must Be Followed By |
| --- | --- | --- | --- |
| 高质量发展 | development goal, industrial upgrading, comprehensive results | single small task or routine notice | indicator, project, quality change |
| 赋能 | technology/platform/finance actually supports something | no clear tool or object | object and method |
| 聚力 | multiple parties invest in one target | one department's routine work | participating subjects and target |
| 抓手 | explaining an implementation carrier | no project,制度, or platform | specific carrier name |
| 体系 | multi-level institutional arrangement exists | only scattered measures | components |
| 格局 | multi-subject or multi-region relation | ordinary work arrangement | participants and relation |
| 机制 | workflow, responsibility, feedback exists | temporary action only | mechanism name and operation |
| 动能 | economy, innovation, employment growth force | ordinary activity | source and manifestation |
| 生态 | innovation/business/culture multi-party environment | single system | subject relation and environmental change |
| 闭环 | discovery, handling, feedback, review exist | no feedback step | loop steps |
| 协同 | cross-department/level/region coordination | one department alone | who coordinates with whom |
| 提质增效 | quality and efficiency both evidenced | only routine推进 | quality and efficiency changes |
| 走深走实 | learning/policy implementation has stages | generic expression | concrete deepening action |
| 落地见效 | policy already executed and has result | just deployed | execution result |
| 凝心聚力 | mobilization, meeting, team-building | technical/business document | common goal |
| 久久为功 | long-term governance/ecology/style work | short-term task | long-term task and stage plan |
| 开创新局面/谱写新篇章 | publicity or speech ending with evidence | routine notice, request,方案正文 | concrete content of the "new" situation |

### Negative List

Watch for and rewrite:

- 空泛套话: direction and attitude without work information. Replace with object and action.
- 过度拔高: ordinary facts called "重大突破" or "历史性成就". Downgrade.
- 机械排比: neat but empty `要……要……要……`. Convert to task list.
- 四字词堆叠: `凝心聚力、提质增效、走深走实` in one sentence. Keep at most one necessary abstraction.
- 万能结尾: `谱写新篇章、开创新局面` in any document. Return to task, deadline, responsibility.
- 虚假具体: `相关部门、重点领域、关键环节` repeatedly used with no real boundary. Name the subject or use clear placeholders.
- 宣传腔过重: routine documents written as praise reports. Keep facts, reduce emotion.
- 理论腔过重: dense concepts with no implementation content. Attach each concept to a task.
- 文种错位: notice written as speech; request written as summary.
- 逻辑空转: from meaning to meaning, no new information.
- 缺少事实支撑: judgment without data, case, mechanism, or feedback.
- 动词无宾语: `扎实推进、全面加强` without what is being advanced or strengthened.
- 抽象词连续堆叠: `赋能、生态、动能、协同` explaining each other.
- 口号密度过高: more statements than facts.
- AI连接句式过密: connectors replace actual cause, sequence, and responsibility.

## Humanizer Pass for Official Documents

Use this after the normal公文 anti-AI pass. It is stricter about text that "looks polished" but still feels generated. Keep the official register; do not add blog-style personality, jokes, first-person opinions, or casual asides unless the requested文体 is a personal speech or public-facing article.

### Rewrite, Do Not Merely Delete

When revising user text, preserve the original coverage and intent. If the input has five substantive points, the output should still cover five substantive points unless the user asks to compress. Replace AI patterns with concrete official wording, not with emptiness.

### Cluster-Based Detection

Do not over-edit a phrase just because it is formal. Flag AI味 when several tells appear together: abstract praise + tidy three-part rhythm + vague subject + no facts + generic ending. A single common transition word or a polished sentence is not enough.

### Public-Document Humanizer Checklist

| AI tell | 公文中的表现 | Rewrite rule |
| --- | --- | --- |
| Significance inflation | `具有重要意义、标志着、彰显了、充分体现了` used without evidence | State the actual task, result, or policy basis |
| Fake depth with participles | `推动...、促进...、助力...、彰显...` chained after one sentence | Keep one main action and give object/process |
| Promotional tone | `亮点纷呈、成效斐然、精彩纷呈、焕发活力` in routine work | Replace with measurable progress or observed change |
| Vague attribution | `有关方面认为、群众普遍认为、社会反响良好` without source | Name the source, survey, feedback channel, or omit |
| Formulaic challenge section | `虽然面临挑战，但前景广阔` | Name the actual difficulty and next handling step |
| AI vocabulary clustering | `关键、赋能、生态、格局、体系、动能` stacked together | Keep the necessary term and attach concrete content |
| Avoiding simple verbs | `发挥着重要作用、承载着重要使命、展现出强大动能` | Prefer `是、有、完成、建立、解决、减少、增加` when enough |
| Rule of three packaging | Every paragraph has exactly three neat items | Use the natural number of tasks; split or merge based on substance |
| Synonym cycling | `单位/部门/机关/主体` alternated to avoid repetition | Repeat the clearest term;公文允许必要 repetition |
| False range | `从思想认识到行动落实、从机制建设到成效转化` without real scale | List the real links or remove the range |
| Passive/subjectless fragments | `已完成整改、将持续推进` with no actor | Add the responsible unit when useful |
| Meta signposting | `下面从三个方面展开、本文将进行阐述` in the deliverable | Start with the content |
| Generic positive conclusion | `未来可期、再上新台阶、谱写新篇章` | End with deadline, responsibility, reporting, or next step |
| Manufactured punchline | Several short dramatic sentences to sound forceful | Use normal official cadence; one short reminder is enough |
| Aphorism formula | `安全是发展的底线、服务是治理的温度` used as filler | Keep only if it directly leads into a concrete task |

### Cadence Rules

- Avoid perfectly symmetrical paragraph design when the material does not support it. Real公文 can have one short paragraph for background and longer paragraphs for measures.
- Avoid making every item begin with the same verb (`强化、强化、强化`) or every heading the same length.
- Repeat official nouns when precision requires it. Do not rotate synonyms just to sound varied.
- Prefer simple verbs where possible: `是、有、建成、完成、发现、整改、报送、反馈、纳入、公开`.
- In formal公文, neutral and plain is the human voice. Do not inject personality merely to sound human.

### Hard Cuts in Final Deliverables

Before final output, remove:

- Chatbot framing: `当然可以、以下是、我为你、希望有帮助、如需继续`.
- Tutorial announcements: `下面我们来看、接下来从以下方面、让我们深入探讨`.
- Knowledge-gap filler: `由于资料有限、根据现有信息推测、可能大概`.
- Decoration: emojis, bolded inline labels, unnecessary English title case.
- Over-dramatic punctuation and web-writing devices. In Chinese公文, prefer normal Chinese punctuation and paragraphing.

### Second-Pass Question

Before final delivery, ask internally:

`如果这篇公文被退回，最可能被批评哪里像 AI 写的？`

Fix the answer before sending. Common fixes:

- If the answer is "空": add facts, actors, mechanisms, deadlines.
- If the answer is "飘": downgrade judgments and remove macro elevation.
- If the answer is "整齐得假": vary sentence and paragraph length based on content.
- If the answer is "不像这个文种": rebuild using the document-type template.
- If the answer is "像聊天回复": remove assistant framing and meta-commentary.

（尾部章节「Positive Rewrite Rules」超长，迁移时裁剪）
