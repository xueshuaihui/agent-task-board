# DOCX 文档处理

## 概述

.docx 文件本质是包含 XML 和资源文件的 ZIP 归档。本 skill 提供完整的创建、编辑、分析能力。

## 脚本命令速查

**输出目录约定**：下文所有命令里的 `$SKILL_OUT` 一律指工作区目录（会话默认 cwd），绝不建在 `{baseDir}` 下，不使用其他存储目录。**执行任何命令前先确保该变量有值**，否则 `"$SKILL_OUT/x.md"` 会退化成写入根目录 `/x.md` 并报权限错误：

```bash
export SKILL_OUT="${SKILL_OUT:-$PWD}"   # 每个会话执行一次
echo "$SKILL_OUT"                        # 交付链接需要这个绝对路径
```

**⚠️ 同名必须更换名称**：写入前检查目标文件是否已存在；若工作区下已有同名文件，必须更换名称（如追加 `-2`、`-v2` 或时间戳后缀），严禁覆盖已有文件。

**⚠️ 临时目录必须隔离**：解包文档或生成中间产物时，临时目录名必须包含唯一标识（如任务 ID、时间戳或随机后缀），例如 `$SKILL_OUT/unpacked-20260831-a3f2/`，**不要用通用名**如 `$SKILL_OUT/unpacked/`。并发环境下通用目录名可能被其他进程覆写导致数据错乱。

**⚠️ Python 保存 `.docx` 必须使用 `BytesIO`：** `doc.save(path)` 底层通过 `zipfile.ZipFile` 直接写文件会触发 `seek`，在 OSS/云存储文件系统上会失败。**默认使用以下写法：**

```python
from io import BytesIO

buffer = BytesIO()
doc.save(buffer)
with open(f"xxx/<name>.docx", "wb") as f:
    f.write(buffer.getvalue())
```

JS 端无此问题 — `Packer.toBuffer()` 在内存中生成，`fs.writeFileSync` 一次性写入，兼容所有文件系统。

| 功能                   | 命令                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **环境探测（开工前）** | `python scripts/doctor.py` — 输出 JSON 环境能力清单，据此选择 .doc 转换与 PDF 渲染路径，避免反复试错       |
| **全量提取（推荐）**   | `python scripts/extract_text.py file.docx -o "$SKILL_OUT/<name>.md"`                                        |
| 全量提取(JSON)         | `python scripts/extract_text.py file.docx -o "$SKILL_OUT/<name>.json" --format json`                        |
| 全量提取(不含图片)     | `python scripts/extract_text.py file.docx -o "$SKILL_OUT/<name>.md" --no-images`                            |
| 全量提取(链接还原)     | `python scripts/extract_text.py file.docx -o "$SKILL_OUT/<name>.md" --links=inline` — 超链接输出 `[文字](URL)`，给模型读 Word 时建议开启；默认 `--links=strip` 只保留链接文字 |
| 全量提取(指定图片目录) | `python scripts/extract_text.py file.docx -o "$SKILL_OUT/<name>.md" --image-dir "$SKILL_OUT/<name>-images"` |
| 单独提取表格           | `python scripts/extract_tables.py input.docx -o "$SKILL_OUT/" --format all`                                 |
| 单独提取图片           | `python scripts/extract_images.py file.docx -o "$SKILL_OUT/images/"`                                        |
| 单独提取图片(去重)     | `python scripts/extract_images.py file.docx -o "$SKILL_OUT/images/" --dedup`                                |
| 单独提取图片(含元数据) | `python scripts/extract_images.py file.docx -o "$SKILL_OUT/images/" --info`                                 |
| 指定表格               | `python scripts/extract_tables.py input.docx -o "$SKILL_OUT/" --table 1`                                    |
| 解包文档               | `python ooxml/scripts/unpack.py file.docx "$SKILL_OUT/unpacked"`                                            |
| 打包文档               | `python ooxml/scripts/pack.py "$SKILL_OUT/unpacked" "$SKILL_OUT/<name>.docx"`                               |
| 验证文档               | `python ooxml/scripts/validate.py "$SKILL_OUT/unpacked" --original file.docx`                               |
| **MD→DOCX（编号引用）**| `node scripts/md2docx.js in.md "$SKILL_OUT/<name>.docx" --cite-style=number`                                 |
| MD→DOCX（脚注引用）    | `node scripts/md2docx.js in.md "$SKILL_OUT/<name>.docx" --cite-style=footnote`                               |
| MD→DOCX（标准主题）    | `node scripts/md2docx.js in.md "$SKILL_OUT/<name>.docx" --theme=standard`                                    |
| DOCX 转 PDF            | `soffice --headless --convert-to pdf --outdir "$SKILL_OUT" document.docx`                                   |
| PDF 转图片             | `python3 -c 'import fitz,sys;d=fitz.open(sys.argv[1]);[p.get_pixmap(dpi=int(sys.argv[3])).save(sys.argv[2]+f"-{p.number+1}.jpg") for p in d]' "$SKILL_OUT/<name>.pdf" "$SKILL_OUT/page" 150` |

> **注意**：`<name>` 为根据用户 query 确定的有意义的文件名，不要使用 `output` 等通用名称；若同名文件已存在，必须更换名称（见上方同名更换规则），严禁覆盖。

## 全量提取（推荐方式）

`extract_text.py` 是一站式提取工具，**同时提取文本、表格和图片**，按文档原始顺序输出（命令见上方速查表）。
图片自动落到 `$SKILL_OUT/<name>-images/`，在 Markdown 中以相对路径引用 `![image](<name>-images/image1.png)`。行为要点：

- **位置还原**：直接遍历 document.xml 的 body 子元素，按 XML 出现顺序处理段落、表格、图片
- **文本框**：自动提取并按多列布局排序，支持 `mc:AlternateContent` 去重
- **表格**：自动转为 Markdown 表格格式，保持在文档中的原始位置
- **图片**：自动提取到 `<name>-images/` 目录（与 `.md` 同级于 `$SKILL_OUT`），按内容哈希去重，在 Markdown 中以相对路径引用
- **不再依赖 pandoc**：完全基于 XML 解析，无需安装额外工具
- **脚注**：始终提取，正文标为 `[^n]`，内容附在文末 `脚注：` 区（不产生 markdown 标题，不影响标题层级）
- **修订与内容控件**：`w:ins`（修订插入）、`w:smartTag`、`w:sdt`（内容控件/表单域）里的文字照常提取；`w:del`（已删除文字）不提取，等价于「接受全部修订后的终稿视图」
- **超链接**：默认只保留链接文字；需要 URL 时加 `--links=inline` 输出 `[文字](URL)`（读 Word 给模型看时建议开启）

## Markdown → Word（含引用，推荐方式）

带引用的 Markdown 转 Word 一律走 `scripts/md2docx.js`，**严禁临场现写 md 解析器**——现写的解析器会把来源标注渲染成与正文同字号的行内链接，产出 `跃升至约66%stanford.edu。` 这类引用与正文混排的结果。

```bash
# 默认：引用上标编号 [1] + 文末《参考文献》
node scripts/md2docx.js report.md "$SKILL_OUT/<name>.docx" --cite-style=number --theme=standard
```

**选项：**

| 选项 | 取值 | 说明 |
| ---- | ---- | ---- |
| `--cite-style` | `number`(默认) / `footnote` / `inline` | 上标编号+文末参考文献 / 页底脚注 / 括注降级 |
| `--cite-detect` | `auto`(默认) / `domain` / `all` / `off` | 引用识别策略；`domain` 只认纯域名，`all` 把所有链接当引用 |
| `--theme` | `standard`(默认) / `business` / `official` | 配色与中英文字体组合 |
| `--title` / `--header` | 文字 / `none` | 文档标题与页眉（默认取首个 `# ` 标题） |
| `--refs-heading` | 文字 | 参考文献章节名，默认「参考文献」 |

**两条引用通道（按输入形态自动选择，无需切换开关）：**

| 材料形态 | 走哪条通道 | 说明 |
| -------- | ---------- | ---- |
| 文中有 `[^id]` 引用 + `[^id]: 文献文字` 定义 | **显式通道** | 文字原样取自定义，**URL 可选**；同一 `[^id]` 多处引用自动复用同一编号 |
| 只有 `[域名](URL)` 这类来源标注 | 推断通道 | 纯域名、同源品牌名、句末紧贴正文的标注 → 上标化 |

> **材料没有 URL 时保持材料中的样子即可**——脚注只输出文献文字，不追加分隔符或链接。
> **不要为了让引用成立而去补一个 URL**：转换器不需要 URL 也能生成规范脚注。

**必须知道的三条行为：**

- 引用识别：纯域名（`stanford.edu`）、同源品牌名（`GitHub`→github.com）、句末紧贴正文的来源标注 → 上标化；自然语言短语的正文链接 → 保留原位超链接
- `[^id]` 找不到对应定义时，原样保留文字并打印警告，不猜测、不静默丢弃
- 与 `extract_text.py` 构成往返闭环：提取产出的 `[^n]` + `脚注：` 区可直接被本工具转回 Word 脚注

> 完整的 Markdown 元素支持矩阵、引用编号合并与《延伸阅读》吸收规则、以及**明确不支持**的引用形态，
> 见 [references/md2docx.md](references/md2docx.md) —— 处理学术/公文类带引用文档前建议先读。

## 生成后必做校验（引用类文档）

引用类文档交付前**必须**跑完 3 条断言：① 来源域名是否仍与正文混排（引用没上标化）；
② 每个含文字的段落是否都显式声明了对齐；③ 正文上标编号数与《参考文献》条目数是否一致。
**可直接复制的命令见 [references/md2docx.md](references/md2docx.md) 的同名章节。**

> ⚠️ **`soffice` 转 PDF 不能替代对齐校验**：LibreOffice 默认左对齐，而中文版 Word 内置正文是两端对齐，
> 未显式声明 `alignment` 的段落在 Word 里会把含长 URL 的行拉散——PDF 里看着正常，Word 里已经散了。

> **📌 校验策略：程序化断言为主，视觉抽查为辅**
>
> 校验分两层，按顺序执行：
>
> 1. **程序化断言（必做）**：用 Python/grep 检查关键属性（字体、字号、行距、对齐、段落数等）。这类检查零成本、可重复，是主要校验手段。
> 2. **视觉抽查（可选）**：渲染 PDF 后抽查若干代表性页面（如封面、典型正文页、末页），确认整体观感。
>
> **退出条件**：程序化断言全部通过 + 视觉抽查（若做了）无明显异常 → 立即交付。
>
> **为什么不要反复迭代视觉细节**：Word 不是像素级排版工具，`soffice` 渲染结果与 Word 实际显示存在差异（如中文字体宽度偏差 10-15%）。对坐标偏移、间距微调等像素级细节的反复修正，通常在目标环境中仍然不对，应满足于"视觉大致正确"。

## 修订追踪工作流

**核心原则**：仅标记实际变更的文本，未变更部分保留原始 `<w:r>` 元素及 RSID；按 3-10 个相关变更分组，
逐批实施并逐批验证。法律 / 学术 / 政府文档**必须**走此工作流。

**开工前必须完整阅读** [references/ooxml.md](references/ooxml.md) 的 "Document 编辑库" 与 "修订追踪 XML 模式"
两节，端到端 6 步流程（pandoc 取 md 表示 → 分组 → 解包 → 分批实施 → 打包 → 验证）见该文件的「修订追踪工作流」章节。
所有中间产物落在 `$SKILL_OUT`，同名必须改名，严禁覆盖。

> 每批实施前重新 grep `word/document.xml` 确认文本位置与 `<w:r>` 拆分——行号在每次脚本运行后都会变化，
> 绝不能沿用上一批记下的行号。

## 依赖安装（服务方部署时执行一次）

以下路径均相对 skill 根目录，在 skill 根目录下执行：

```bash
# 必需：Python 依赖（python-docx / defusedxml / lxml）
pip install -r requirements.txt

# 可选：Markdown→Word 与从零创建文档（docx-js），安装本 skill package.json 声明的 docx@^9.7.1
npm install

# 可选：修订追踪工作流需 pandoc；DOCX→PDF→图片需 LibreOffice
#   macOS : brew install pandoc && brew install --cask libreoffice
#   Debian: sudo apt-get install pandoc libreoffice
```

> **依赖缺失时的降级**：`pandoc` 不可用 → 用 `scripts/extract_text.py` 做修订前后文本比对（代价是看不到
> tracked changes 标记，仅能确认终稿文字）；`soffice` 不可用 → 跳过 PDF/图片预览，不影响 .docx 产出。

## 开工前环境探测

涉及 .doc 旧格式转换或 PDF 渲染校验的任务，**开工前先运行一次 `doctor.py`**，读取 JSON 输出后直接选择路径，不要在后续步骤中反复探测环境：

```bash
python scripts/doctor.py
```

输出 JSON 包含三个核心判断：

| 字段 | 含义 | Agent 决策 |
| ---- | ---- | ---------- |
| `doc_conversion.textutil` | macOS textutil 可用 | .doc → .docx 首选此路径 |
| `doc_conversion.soffice` + `soffice_path` | LibreOffice 可用及路径 | .doc → .docx / DOCX → PDF 使用此路径 |
| `doc_conversion.word_com` | Win Word COM 可用 | .doc → .docx 首选此路径 |
| `doc_conversion.wps_com` | Win WPS COM 可用 | .doc → .docx 降级路径 |
| `doc_conversion.constrained_mode` | Win PowerShell 受限模式 | COM 调用可能被拦截，需降级方案 |
| `pdf_rendering.pymupdf` | PyMuPDF 可用 | PDF 转图片使用 `import fitz`（已确认双端安装） |

> **不需要 doctor.py 的场景**：纯 .docx 读写（extract_text / md2docx / 解包打包）不涉及外部工具，可跳过。

## Windows 端特殊处理

### .doc 旧格式转换

Win 端按以下优先级选择转换方式：

**1. Word COM（推荐，doctor 输出 `word_com: true` 时）：**

```powershell
powershell -NoProfile -NonInteractive -Command "
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Open('C:\path\to\input.doc')
$doc.SaveAs2('C:\path\to\output.docx', 16)
$doc.Close(); $word.Quit()
"
```

注意：`SaveAs2` 的第二个参数 `16` = wdFormatDocumentDefault (.docx)。路径必须是**绝对路径**，相对路径会被 COM 解释为 Word 的工作目录。

**2. VBScript 降级（Word COM 可用但 PowerShell 受限时）：**

```vbs
' save as convert.vbs
Set w = CreateObject("Word.Application")
w.Visible = False
Set d = w.Documents.Open(WScript.Arguments(0))
d.SaveAs2 WScript.Arguments(1), 16
d.Close : w.Quit
```

```cmd
cscript //nologo convert.vbs "C:\path\to\input.doc" "C:\path\to\output.docx"
```

VBScript 不受 PowerShell 执行策略限制，编码必须为 **ASCII**（不要用 UTF-8 BOM），否则 `cscript` 报语法错误。

**3. WPS COM（无 Word 但有 WPS 时）：**

将 `Word.Application` 替换为 `Kwps.Application`，API 相同。

### PDF 渲染

Win 端 PDF 渲染**统一使用 PyMuPDF**：

```python
import fitz
doc = fitz.open("output.pdf")
for page in doc:
    pix = page.get_pixmap(dpi=150)
    pix.save(f"page-{page.number + 1}.jpg")
```

如果安装了libreoffice, 使用soffice 做PDF转换, 转换前先确认是否已安装。

### 常见陷阱

- **PowerShell 受限模式**（`constrained_mode: true`）：企业环境中 `New-Object -ComObject` 被拦截，此时必须降级到 VBScript 方案。
- **中文路径编码**：Win 端中文路径在 PowerShell 中需双引号包裹，VBScript 中需用 ANSI 编码（系统默认代码页）。UTF-8 编码的 .vbs 文件会导致路径解析失败。
- **COM 对象残留**：Word COM 如果中途崩溃（如文件格式错误），会留下僵尸进程。脚本中应使用 `try/finally` 确保 `$word.Quit()` 被调用。

## 呈现交付物给用户（必做）

执行完成后必须调用交付工具，把最终 Word 产物交付给用户。回复里**每个文件都必须写成
`[文件名](绝对路径)` 形式的 markdown 链接**，否则桌面 app 的 Tauri opener 会以
"Not allowed to open path" 拒绝——相对路径（`已生成 reviewed.docx`）和纯文本文件名都打不开。

```markdown
- [reviewed.docx](/Users/<you>/workspace/reviewed.docx) — 含批注的最终版
```

> 💡 拿不准工作区实际路径时，用 `echo "$SKILL_OUT"` 取绝对路径再拼进链接。

## 执行纪律与工作模式

本节提供跨场景的执行指引，帮助选择正确的工作模式以避免无效的 token 消耗和执行死循环。这些指引不改变上方各节的具体操作流程，只在执行层面提供决策框架。

### 开工前：评估复杂度，选择工作模式

选定场景路线后，先评估任务复杂度，据此规划执行策略：

| 复杂度 | 判断标准 | 推荐工作模式 |
| ------ | -------- | ------------ |
| **轻量** | 单一操作：提取内容、简单排版、文本精炼、格式转换 | 直接执行，不做过度规划 |
| **中等** | 多步骤但有明确规范：模板套用、内容扩充、修订追踪、合同编辑 | 先完整规划脚本逻辑，一次写完再执行 |
| **重量** | 多文档对比、大规模格式转换、含图表处理、跨语言翻译 | 先制定分步计划，每步设检查点和退出条件 |

重量级任务若在执行中发现某一步骤持续受阻（如同一错误反复出现、同一需求反复探索），应暂停当前路径，重新评估是否可简化方案或降级处理（见下方「能力边界」）。

> **涉及 .doc 转换或 PDF 渲染的任务**，开工前先运行 `python scripts/doctor.py`（详见上方「开工前环境探测」），读取输出后直接选定路径——不要在执行中途反复探测环境。

### 脚本一次写完，避免增量调试

文档生成/编辑属于确定性任务，推荐采用"规划 → 一次写完 → 一次执行 → 程序化验证 → 针对性修正"的工作模式。

每轮"修改→运行→检查"循环都会重新加载完整上下文，累积的 cache token 开销可观。因此，应在编码前充分思考脚本逻辑，尽量一次写完，而不是写一小段就运行看效果。

报错时的处理顺序：

1. **读**：完整阅读错误输出（stderr、exit code、traceback），不要跳过
2. **诊**：判断是环境问题（缺依赖、路径不存在）还是逻辑问题（参数错误、格式不匹配）
3. **修**：针对性修复，一次只改一个变量
4. **验**：修复后先做轻量验证（如 `echo $?`、`ls`），再跑完整流程

若修复后仍报错，应换用完全不同的实现路径（如从 python-docx 切换到 OOXML 解包编辑），而不是在同一错误路径上反复微调。

### 模糊需求的处理

当用户需求存在歧义（如"参考某文档的格式""按照那个风格来"）时，做少量探索以理解需求方向；若短时间内无法确定唯一正确解释，**直接采用场景决策表中对应场景的推荐方案**执行，在输出中说明选择了哪种解释，让用户决定是否调整。

避免在模糊需求上反复搜索、验证、排除，试图找到"唯一正确答案"——多数情况下不存在唯一解，推荐方案本身就是合理选择。

### 能力边界与降级策略

以下场景超出本 skill 的合理能力范围，应降级处理或告知用户：

| 超范围场景 | 降级策略 |
| ---------- | -------- |
| 图表内嵌文字的 OCR 翻译和像素级重绘 | 仅翻译图注（caption），图内文字保留原文并告知用户 |
| 大规模图片处理（批量裁剪、调色、去水印） | 应使用专业图片工具，本 skill 仅处理文档结构 |
| 图片/扫描件转 Word（OCR 重建） | 已在 description 中声明不适用，告知用户改用其他工具 |

> 降级时在输出中明确说明：哪些部分做了处理、哪些部分保留原样、原因是什么。不要在超范围任务上持续投入——当发现自己在处理本质上不属于文档结构的问题（如像素级图片编辑）时，应及时止损并降级。

## 注意事项

docx(doc)生成/编辑任务耗时可能较长，需要设置足够的超时时间。⚠️ 超时设置：调用时必须设置 timeout ≥ 1800 秒
