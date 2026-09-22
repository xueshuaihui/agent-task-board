
# PowerPoint / 演示文稿 Skill（统一入口）

本技能是所有 PPT / 演示文稿 / 幻灯片请求的**统一入口**，本文件只做**任务分流**——判定任务类型后跳到对应 profile 的主入口文档执行，**不要**把各 profile 细节都读进来。

参考文档按三个 profile 组织，每个 profile 一个专属目录 + 同名主入口，入口会指引后续该读哪些子文档：

| Profile | 主入口 | 何时用 |
| --- | --- | --- |
| **从零生成** | `references/from-scratch/from-scratch.md` | 所有从零制作 / 基于 brief 创作（风格库驱动、视觉精致；入口内含完整 / 快速子链路分流） |
| **基于用户模板生成** | `references/from-template/from-template.md` | 用户上传 / 指定自己的 .pptx，要以它为模板生成**全新内容**的完整 PPT（多模态理解 + JS 复刻重建） |
| **编辑已有 ppt** | `references/editing/editing.md` | .pptx 的编辑 / 美化 / 基于已有内容再生成（按改动幅度分 脚本重建 / 小改 / section 改 / 大改） |
| 共享规范 | `references/shared/` | `delivery.md` 交付协议 / `qa.md` QA 规范 / `speech-script.md` 演讲稿——各 profile 在对应环节调用 |

> ⚠️ 网页版 HTML 链路与「预设模板库链路」均已下线删除（见文末「目录速查 · 已删除」）。

---

## 第一步：判定任务类型

拿到请求先归入下面四类之一，再走对应小节：

1. **制作新幻灯片（从零 / 基于 brief，不涉及现成 .pptx）** → 「从零生成」 profile。
2. **用户自带模板生成全新内容**（上传 / 指定 .pptx，诉求是"用它作模板生成全新内容"，新内容是本次创作而非改写模板旧内容）→ 「基于模板生成」 profile。
3. **编辑已有幻灯片**（改文字 / 配色 / 图片 / 布局 / 修排版 / 美化 / 基于已有内容再生成）→ 「编辑已有 ppt」 profile。
4. **读取 / 提取 `.pptx` 内容**（抽文本 / 看缩略图 / 看结构）→ 走「读取 .pptx」。

---

## 「从零生成」 profile

收到**从零制作**请求（"做个PPT""生成演示文稿""make slides""做套幻灯片"等，且没有指定要编辑的现成 .pptx 文件）时，**不弹链路卡**——**读 `{baseDir}/references/from-scratch/from-scratch.md`**（profile 主入口 / 指挥总线）并按其阶段推进。完整 / 快速子链路的分流判定表在入口「第一步」——严格按入口分流、**只读命中的那一份 workflow**。

链路概要：建目录 + 清单 → 信息收集 → 风格与配色 → 大纲（无确认闸门）→ 配图（后台并行）→ 内容编排 → **一次写构建脚本并产出 pptx** → QA → 交付。

- **用户明确要 "传统 PPT / pptx / PowerPoint 原生" 的从零成品**：也走本 profile（产出的就是原生 pptx），不要拒绝。
- **注意**：本节只管**从零制作**。用户要**以其自带模板为壳生成全新内容** → 走下一节「基于模板生成」；在**已有 .pptx 上编辑 / 美化 / 再生成** → 走「编辑已有 ppt」 profile。

---

## 「基于模板生成」 profile

用户上传 / 指定自己的 .pptx，且诉求是**以它为模板生成全新内容的完整 PPT**（"用这个模板做一份 XX""按这个模板生成"，新内容是本次创作而非改写模板旧内容）时：**读 `{baseDir}/references/from-template/from-template.md`**（profile 主入口：截图前 10 页多模态理解 → build_template.js JS 复刻 → build_pptx.js 生成，需 VLM 环境；复杂组件复刻规范在同目录 `mimic-redraw.md`）。

与「编辑已有 ppt · 大改」的分界：大改是对模板既有内容改造，模板生成的内容是全新的；含糊时向用户确认一句再动。

---

## 「编辑已有 ppt」 profile

**所有编辑一律走 `{baseDir}/references/editing/editing.md`**（profile 主入口 / 路由），不弹链路卡。按改动幅度分三档：

| 档位 | 何时用 | 做法 |
| --- | --- | --- |
| **小改（外科手术）** | 改几处文字 / 换一张图 / 加删一页，原设计不动 | lxml 直改 XML 内容位，效果位零接触，100% 保真 |
| **section 改（主题不变）** | 改一段 section 的内容表述 / 美化优化 / 多页文字更新，主题与配图保留 | 克隆式重建 · 内容延续型：逆向模板档案 → 克隆供体页 → 改内容位，原配图做图片理解后尽量复用 |
| **大改（主题更换）** | "照这个风格做一份 XX""用这个模板讲另一件事""改版式/重新排版" | 克隆式重建 · 版式参考型：仅继承配色/元素设计/风格，内容与配图全换（封面品牌图视情况可留） |

另有**脚本重建**（本 skill 自己生成的 deck、脚本还在 → 改脚本重跑），优先于上述三档。

**读 `{baseDir}/references/editing/editing.md`**（路由入口）按其判定规则分岔到对应详情文件。

判定要点：

- **从零生成 profile 只负责从零生成、不提供编辑**：用户要修改本技能此前生成的幻灯片 → 走编辑 profile 脚本重建。
- 用户上传 `.pptx` 附件且要**以它为壳生成全新内容** → 不属本 profile，回上一节「基于模板生成」；其余编辑 / 美化 / 再生成按改动幅度自动分岔 小改 / section 改 / 大改。
- **section 改 / 大改内置风格库一票否决**：不选 js_style.json 风格，样式基因只从用户 pptx 逆向提取。

---

## 读取 / 提取 .pptx 内容

从一个 `.pptx` 里取信息（不生成、不编辑），用传统链路脚本（都在 `{baseDir}/scripts/`）：

- **抽纯文本**：`python {baseDir}/scripts/shared/extract_text.py <presentation.pptx> [out.md]`（省略 out.md 时打 stdout；无任何 `--` 选项）
- **看幻灯片缩略图总览**：`python {baseDir}/scripts/shared/thumbnail.py <presentation.pptx> [输出前缀] [--cols 列数]`（人工 QA 辅助，agent 无视觉模态）
- **看底层 XML 结构**：`python {baseDir}/scripts/office/unpack.py <presentation.pptx> <输出目录>`

---

## 全链路硬规则：技能目录只读 + 工作目录命名

以下两条对**所有链路**生效，违反会导致产物丢失或并发互撞：

1. **技能目录 `{baseDir}` 只读，也绝不能作为当前工作目录**。所有脚本一律用 `{baseDir}` 前缀的**绝对路径**调用（如 `python {baseDir}/scripts/shared/extract_text.py …`），**禁止 `cd` 进 `{baseDir}`、禁止在 `{baseDir}` 下创建任何目录或写任何文件**——技能目录是会话级资产，会被运行时重建 / 清理，写进去的东西随时会消失。**开工前自检（硬性）**：任何建目录 / 写文件前先确认 shell 当前目录（`pwd`）不在 `{baseDir}` 内（路径含 `/skills/pptx` 即为已进入）；若已在内，必须先 `cd` 回会话默认工作目录再开工。
2. **任务工作目录（deck 目录）一律建在用户数据区交付根下，绝不建在 `{baseDir}` 下**（建在 `{baseDir}` 下会出现 `skills/pptx/PPT/…` 叠路径且产物随技能目录清理而丢失）。具体目录名按各链路详情文档：**pptxgenjs 生成链路**的目录由 `init_deck_dir.py` 脚本创建，默认落在 `/root/userdata/workspace/PPT/<yyyymmdd>/<task-name>/`（task-name 命名规则按 `references/from-scratch/from-scratch.md` 执行，用用户 query 语种 + PPT 后缀）；**编辑链路**为 `/root/userdata/workspace/PPT/<yyyymmdd>/<task-name>/`，且 `<task-name>` **只用小写英文字母、数字、连字符（纯 ASCII）**，禁止中文 / 空格 / 特殊字符（交付文件名不受此限，仍用用户 query 语种）。交付物与中间产物**同址存放**：交付物就在 deck 目录根下（经 `finalize_deck.py` 打印的 MEDIA 行交付），全部中间产物都在 `work/` 文件夹里，交付后**不拷贝、不删目录、不清理**——见 `references/shared/delivery.md`。
3. **跨平台执行须知（Windows / PowerShell 必读，全链路生效）**：所有文件一律走 write 工具写盘，绝不用 heredoc；命令必须**单行**写完；**禁止管道 / 串联命令（硬性）**——不得用 `&&`、`||`、`;`、`|`，每条命令只跑一件事；**不要 `cd` 到目录再执行**——脚本均以绝对路径调用。

---

## 目录速查

```
references/
├── from-scratch/          # profile 1：从零生成
│   ├── from-scratch.md    # 主入口（指挥总线，含完整/快速分流）
│   ├── workflow-fast.md   # 快速子链路（页数≤10 / 材料就绪 / 用户要快）
│   ├── info-gathering.md、outline.md、images-prep.md、page-content.md
│   ├── style-selection.md（风格与配色） + js_style.json（风格库）
│   └── api-pptxgenjs.md（API 参考 + build_pptx.js 构建协议 + 版式硬规则）
├── from-template/         # profile 2：基于用户模板生成全新内容
│   ├── from-template.md   # 主入口（指挥总线，固定 4 步序列 + 步骤文档指针，需 VLM）
│   ├── template-understanding.md（步骤一模板理解） / build-template.md（步骤二复刻代码） / build-final.md（步骤三内容生成） / final-verify.md（步骤四终验交付）
│   └── mimic-redraw.md（复杂组件拟态重绘）
├── editing/               # profile 3：编辑已有 ppt
│   ├── editing.md         # 主入口（路由：脚本重建 / 小改 / section 改 / 大改）
│   ├── script-rebuild.md、ooxml-editing.md（小改）、template-rebuild.md（section改/大改克隆重建）
│   └── layout.md、images.md、style-zh.md、design-styles.md、narrative.md、pptxgenjs-fallback.md、footguns.md（支撑规范）
└── shared/                # 跨 profile 共享
    ├── delivery.md（交付协议，QA 通过后必读）
    ├── qa.md（QA 规范，从零完整链路 + 编辑内容复核）
    └── speech-script.md（演讲稿，交付后按需）
```

- **从零生成 profile 脚本**：`scripts/from-scratch/`（`init_deck_dir.py`（预写 build_header.js 样板）/ `build_header.js`（build_pptx.js 固定样板）/ `style_library.py`（风格库 list / get）/ `lint_build.py`（构建脚本静态检查））、`scripts/shared/batch_generate_images.py`（含 `remove_white_bg.py` 白底扣透明）、`scripts/shared/check.py`（产物统一校验 QA 唯一入口，--no-layout / --no-xsd 豁免，--fonts 列/验本机中文字体）、`scripts/shared/extract_text.py`（关键句抽查用）、`scripts/shared/finalize_deck.py`（交付前置一体化：自动嵌入 + 留存交付快照到 `work/` + 打印 MEDIA 行，一次调用完成，不拷贝不清理；--compare 一致性比对，见 delivery.md）。
- **模板生成（from-template）profile 脚本**：`scripts/from-template/`（`extract_template_profile.py`（模板机器档案，内置组件扫描与打包字体检测） / `export_template_assets.py`（模板素材一次性抽取：media 拷贝+PPT 侧蒙版烘焙 rendered/+装饰性组合整组烘焙不拆散+同图去重+逐张页码位置登记+复用/配图替换分类） / `carry_fonts.py`（模板打包字体原样搬进产物，幂等） / `check_fit.py`（槽位容量预检） / `merge_section.py`（JS 新页 OPC 合入）。
- **编辑 profile 脚本**：`scripts/editing/`（`fill_text.py` / `fill_table.py` / `fill_chart.py` / `swap_image.py` / `component_clone.py` / `component_reflow.py` / `page_recompose.py` / `extract_titles.py` / `clean_orphans.py` / `center_content.py` / `validate_pptx.py` / `check_layout_native.py` / `add_slide.py` 复制页）；只读分析与预览 `scripts/shared/`（`check.py` / `extract_text.py` / `analyze_pptx.py` / `finalize_deck.py` / `thumbnail.py` / `render_preview.py`（渲染预览，跨链路共用，内置 PowerPoint→LibreOffice 降级））与 `scripts/office/unpack.py`。

> 面向用户一律用自然语言（"幻灯片 / 页面"），**不暴露** `链路` / 脚本名 / 参考文档名 / `HTML` / `XML` / `pptxgenjs` 等技术术语——各链路详情文档里有更细的去技术化措辞规则。

> **交付协议（全 profile 共享）**：所有 profile 的交付动作统一按 `references/shared/delivery.md` 执行（`finalize_deck.py` 自动嵌入 + 快照 + 最终回复保留 MEDIA 行 + 任务总结；总结用用户 query 语种、去技术化、不透中间产物），各链路详情文档在交付步骤处指向该协议。
