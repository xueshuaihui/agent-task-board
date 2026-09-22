
# PDF 处理指南

## 概述

本 skill 提供 PDF 操作能力（生成、合并、拆分、表单填写等）。**PDF 解析（文本提取、表格提取、OCR）请使用 `[file-read]` skill。**

对于具体场景的代码示例和高级用法，请查阅 `references/` 目录下的参考文档。表单填写流程请查阅 forms.md。

### 能力一览

| 能力     | 说明                       | 推荐工具                     |
| -------- | -------------------------- | ---------------------------- |
| 文档生成 | 程序化创建带样式的 PDF     | reportlab (Platypus)         |
| 合并拆分 | 多文档合并、按页/范围拆分  | pypdf, qpdf                  |
| 页面操作 | 旋转、裁剪、重排序         | pypdf                        |
| 水印加密 | 添加水印、密码保护         | pypdf                        |
| 表单处理 | 检测、提取、填充表单字段   | `scripts/form_fields.py`     |
| 注解填充 | 非可填充表单的视觉定位填写 | `scripts/annotation_form.py` |
| 页面渲染 | PDF 转 PNG、标注叠加验证   | `scripts/pdf_imaging.py`     |

> **⚠️ PDF 解析提醒**：本 skill 不负责 PDF 文本/表格提取。如需解析 PDF 内容，请使用 `[file-read]` skill。

## 脚本命令速查

所有输出文件必须保存到 skill 的 output 目录下，按日期隔离避免同名冲突：

```bash
SKILL_OUT="/root/userdata/workspace/pdf/output/$(date +%Y-%m-%d)"
mkdir -p "$SKILL_OUT"
```

| 功能     | 命令                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 表单检测 | `python scripts/form_fields.py detect <pdf>`                                                             |
| 字段提取 | `python scripts/form_fields.py inspect <pdf> "$SKILL_OUT/<name>.json"`                                   |
| 表单填充 | `python scripts/form_fields.py populate <pdf> <values.json> "$SKILL_OUT/<name>.pdf"`                     |
| 渲染图片 | `python scripts/pdf_imaging.py render <pdf> "$SKILL_OUT"`                                                |
| 叠加标注 | `python scripts/pdf_imaging.py overlay <page> <fields.json> <input_img> "$SKILL_OUT/<name>_overlay.png"` |
| 布局校验 | `python scripts/annotation_form.py validate <fields.json>`                                               |
| 注解填充 | `python scripts/annotation_form.py fill <pdf> <fields.json> "$SKILL_OUT/<name>.pdf"`                     |
| 页面旋转 | `python scripts/rotate_pages.py <input.pdf> "$SKILL_OUT/<name>.pdf" --angle 90`                          |
| 添加水印 | `python scripts/add_watermark.py <input.pdf> "$SKILL_OUT/<name>.pdf" --text "水印"`                      |
| 补加标识 | `python scripts/ai_label.py <input.pdf> "$SKILL_OUT/<name>.pdf"`                                         |

> **注意**：`<name>` 为根据用户 query 确定的有意义的文件名，不要使用 `output` 等通用名称。

## 场景导航

需要具体代码示例和高级用法时，按场景查阅 `references/` 目录下的对应文档：

### Python 库参考

| 文档                              | 内容                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `references/python-pypdfium2.md`  | pypdfium2 高级渲染：缩略图生成、区域文本提取         |
| `references/python-pdfplumber.md` | pdfplumber 精确提取：表格识别、视觉区域定位          |
| `references/python-reportlab.md`  | reportlab 专业排版：结构化报告生成、**中文字体注册** |

> **⚠️ 中文支持提醒**：使用 reportlab 生成包含中文内容的 PDF 时，**必须先注册中文字体**，否则中文会显示为方块。本 skill 在 `scripts/fonts/NotoSansSC.ttf` 自带了思源黑体（OFL 许可证），可直接使用，无需依赖系统字体。详见 `references/python-reportlab.md` 中的「中文字体支持」章节。

### JavaScript / CLI 参考

| 文档                       | 内容                                         |
| -------------------------- | -------------------------------------------- |
| `references/javascript.md` | pdf-lib 文档创建/编辑、pdfjs-dist 浏览器渲染 |
| `references/cli-tools.md`  | poppler 批量转换、qpdf 优化/拆分/修复        |

### 实战与排障

| 文档                            | 内容                                           |
| ------------------------------- | ---------------------------------------------- |
| `references/patterns.md`        | 批处理、大文件分片处理                         |
| `references/troubleshooting.md` | 加密文档处理、损坏修复、性能监控、依赖许可一览 |

### 表单处理

- **forms.md** — PDF 表单填写完整流程（可填充表单 vs 非可填充表单的处理路径）

## AI 生成标识（必须遵守）

**所有涉及修改 PDF 内容的操作，最终输出的 PDF 必须在最后一页右下角添加"内容由 AI 生成"标识。**

- 内置脚本（`form_fields.py populate`、`annotation_form.py fill`、`add_watermark.py`）已自动添加，无需额外处理。
- **临时生成的 Python 脚本**（如用 reportlab 生成新 PDF、用 pypdf 编辑/合并内容等），如果涉及创建或修改 PDF 内容，**必须**调用公共工具函数 `add_ai_generated_label`。它支持两种调用方式：

```python
from ai_label import add_ai_generated_label

# 方式一：写入前传 PdfWriter 实例（在 writer.write() 之前调用）
add_ai_generated_label(writer)

# 方式二：doc.build()/writer.write() 已落盘后，直接传 PDF 文件路径就地补加（幂等）
add_ai_generated_label(OUTPUT_PDF)   # OUTPUT_PDF 为 str / Path
```

> 该函数位于 `scripts/ai_label.py`，会在最后一页右下角绘制半透明灰色小字标识，使用 skill 自带的思源黑体。
>
> **⚠️ 不得改变正文颜色/透明度**：标识覆盖层的透明度（`alpha`）仅作用于标识文字自身所在的局部图形状态与专属 ExtGState，**绝不能**用整页透明覆盖层或全局 `setFillAlpha`/`setFillOpacity` 去"叠加"标识——那会把正文一起洗浅。若发现输出 PDF 文字异常变浅，重点排查生成脚本里的 `textColor`/`TEXTCOLOR`/`setFillColor`/`setFillAlpha`，标识后处理不应是元凶。

- **兜底后处理**：如果临时脚本已经生成了 PDF 但忘记调用 `add_ai_generated_label`，可用 CLI 命令对已有文件补加标识：

```bash
python scripts/ai_label.py <input.pdf> "$SKILL_OUT/<name>.pdf"
```

> **⚠️ 强烈建议**：所有涉及内容修改的工作流，在最终输出 PDF 后，都应检查是否已包含 AI 标识。如不确定，直接对输出文件运行上述兜底命令即可（重复添加不会产生问题）。

以下操作**不需要**添加标识：

- 仅旋转页面方向（`rotate_pages.py`）
- 仅拆分/提取页面（不改变页面内容）
- 仅检测/提取表单字段信息（`detect`、`inspect`）
- 仅渲染 PDF 为图片（`pdf_imaging.py render`）

## 注意事项

⚠️ 超时设置：调用时必须设置 timeout ≥ 1800 秒

⚠️ **中文引号/特殊字符转义（必须遵守）**：reportlab 的 `Paragraph` 使用类 XML 解析器，文本中的 `&`、`<`、`>` 会导致解析报错。所有动态文本（用户输入、变量拼接）必须使用 `xml.sax.saxutils.escape` 转义后再传入 Paragraph。详见 `references/python-reportlab.md` 中的「中文引号与特殊字符转义」章节。

⚠️ **文本颜色与字重规范（必须遵守）**：生成的 PDF 正文文本必须使用深色（`#1A1A1A` 或更深），**禁止使用浅灰色文字**（如 `colors.grey`、`#999999`）；标题使用黑色 + 中文字体。详见 `references/python-reportlab.md` 中的「排版规范：字体粗细与文本颜色」章节。

**交付**
使用`MEDIA: /root/userdata/workspace/xxx`进行交付
