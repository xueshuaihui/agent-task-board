> 本技能由千问工作台技能降级迁移，原平台专属能力不可用。

# Image TransOffice — 图片转 Word / Excel / PDF

## 概述

Image TransOffice 将单张图片转换为 Office / PDF 文档：图片转 Word 输出 `.docx`，图片转 Excel 输出 `.xlsx`，图片转 PDF 输出 `.pdf`。产物以本地文件路径返回。

## 能力详情

- **图片转 Word（`word`）**：将文档图片（试卷、书籍、公章等）转换为结构化 Word，精准提取印刷与手写文字并还原排版，支持批注与修订。适用于会议资料整理、合同内容修改、教学文档归档。
- **图片转 Excel（`excel`）**：将表格图片（财务报表、账单等）转换为结构化 Excel，精准识别票据与单据的表格结构，完整还原行列、合并单元格及表头数据。适用于财务台账建立、病历单据录入。
- **图片转 PDF（`pdf`）**：将 JPG/PNG/BMP 等常见图片转换为 PDF，保留原始分辨率与排版。适用于财务票据归档、教学资料留存、售后凭证处理、合同标准化流转。

## 使用方式

```bash
  --image "</root/userdata/下的图片本地绝对路径>" \
  --target-format "<word|excel|pdf>" \
  [--file-format "png"] \
  [--timeout 120]
```

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--image` | 是 | 待转换图片的本地绝对路径，**必须以 `/root/userdata` 开头**；不支持 URL 或 base64（URL 图片请先下载到本地再传入） |
| `--target-format` | 是 | 目标文档类型：`word`/`doc`/`docx`、`excel`/`xls`/`xlsx`、`pdf` |
| `--file-format` | 否 | 输入图片格式，默认按 `--image` 后缀推断，无法推断时用 jpg |
| `--timeout` | 否 | 处理超时时间（秒），默认 120 |

## target-format 判断指南

根据用户意图选择 `--target-format`：

| 用户表达 | target-format |
|----------|---------------|
| Word、doc、docx、可编辑文档、图片转文字版文档 | `word` |
| Excel、xls、xlsx、表格图片、截图里的表格要变表格文件 | `excel` |
| PDF、扫描件、归档、打印、保留版式 | `pdf` |
| 只说"图片转文档"且无表格/保留版式倾向 | `word` |


## 输出格式

脚本将产物输出到 stdout，每行一个 `MEDIA:` 前缀的本地文件路径；处理过程与错误信息输出到 stderr。

### 成功

```
MEDIA:/root/userdata/workspace/scanner/scan_20260728_104243_c32b0397/output.docx
```

### 失败

进程以非 0 退出，错误信息输出到 stderr：

```
❌ 图片转文档失败 (word): <错误信息>
```

## 交付物展示（必须严格遵守）

**成功时**：**你的回复必须包含 `MEDIA:` 行，这是唯一的交付方式。** 从脚本 stdout 中提取所有以 `MEDIA:` 开头的行，**逐行原样复制**到你的回复中。没有 `MEDIA:` 行 = 没有交付 = 任务失败。

**回复格式示例**：

```
MEDIA:/root/userdata/workspace/scanner/scan_20260728_104243_c32b0397/output.docx

转换完成。还需要调整吗？
```

> ⚠️ **`MEDIA:` 行必须放在回复最前面**：先输出所有 `MEDIA:` 行，再输出简短文字说明。
>
> ⚠️ **禁止自行展示结果**：禁止用 Markdown 链接、HTML 标签、裸路径或任何 URL 展示交付物；`MEDIA:{本地文件路径}` 是唯一合法格式。
>
> ⚠️ **严禁编造路径**：路径必须 100% 来自脚本 stdout 的 `MEDIA:` 行，逐字符复制，有几行就输出几行，不多不少。路径均以 `/root/userdata/workspace/scanner/` 开头，如果不是，说明抄错了。
>
> ⚠️ **禁止只输出文字描述而不输出 `MEDIA:` 行**：如"转换完成！"但没有 `MEDIA:` 行，这是严重错误。

- **失败时**：将 stderr 中的错误信息如实转述给用户，不要只说"失败了"。

## 调用示例

```bash
# 图片转 Word

# 表格图片转 Excel

# 图片转 PDF
```

## 注意事项

1. **输入路径**：`--image` 只接受 `/root/userdata` 开头的本地文件路径；URL 图片需先下载到本地，不支持 base64
2. **图片格式**：支持 jpg、png、bmp 等常见图片格式
3. **单张处理**：一次仅转换一张图片，批量请多次调用
4. **超时设置**：默认 120 秒，复杂文档可适当增加
