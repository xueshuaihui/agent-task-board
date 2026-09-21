# `/skills/sources` 与 `/skills/import` 合并评估（v0.0.4 #19 ②，PRD r3 口径）

现状（W2 后）：
- `sources` 三端点（GET/PUT `sources`、POST `sources/scan`）= 8.8「技能目录」配置，存 settings kv；
  `scan` 只读地列目录里的候选文件（name_guess/kind），不写 skills 表；git/http 历史源标 unavailable、扫描回 501；含路径穿越校验。
- `import`/`import-markdown` = 把用户选定的单个文件解析、按同 ID 判冲突（409/覆盖/跳过），落库为「三方技能」。
- PRD r2 已删「导入来源」概念（`import_origin` 列移除），r3 措辞把 `sources` 语义改指「导入方式」而非「来源」。

结论：**保留两端点，不合并。**
1. 职责不同：sources/scan 是「目录发现」（多文件预览），import 是「单文件落库」（含冲突决策）；合并会把「浏览目录 + 逐文件覆盖/跳过」压进一次请求，破坏 §9.8.2 的预览→冲突→确认流程。
2. 数据模型正交：sources 是可增删的目录配置列表（含 builtin/遗留 git/http），import 无「目录」概念。
3. 校验语义各异：scan=路径穿越/绝对路径/501；import=multipart/1MB 上限/JSON schema/同 ID 冲突——合并将耦合两套错误面。
4. 命名风险：叫「sources」易与被删的「来源」混淆，但它是「导入目录/方式」，与来源收敛不冲突，改名即可、不必并接口。

后续（非本次）：如需省一步，可给 `import` 增可选 `source_id`+`file`，从扫描结果直接落库；`sources` 端点仍独立保留。
