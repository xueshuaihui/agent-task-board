
# Doc Image Scan — 文档图片扫描增强

## 概述

Doc Image Scan 是面向文档照片和普通图片的扫描增强 skill。它把手机拍摄、截图或翻拍图片处理为更清晰、更规整、更易归档的结果，覆盖扫描件生成、文档净化、画质提升和艺术化处理等场景。所有能力均通过 /root/userdata 下的本地图片路径输入；产物以本地 `MEDIA:` 路径返回。

## 能力列表

| 序号 | 能力名称 | ability 参数值 | 说明 |
|------|----------|----------------|------|
| 1 | 扫描文件 | scanFile | 对文档照片去噪、畸变矫正与画质优化，生成高清规范扫描件 |
| 2 | 素描速写 | sketchDrafting | 将普通照片转换为素描或速写风格画作 |
| 3 | 试卷增强 | examEnhance | 去除杂色与背景干扰，提升笔记、试卷及教材清晰度 |
| 4 | 证件票据增强 | certificateEnhance | 优化模糊、偏暗的证件或票据图片，保留文字细节 |
| 5 | 图像去手写 | removeHandwriting | 擦除手写批注、划痕或签名，尽量保留印刷原文 |
| 6 | 图像去水印 | removeWatermark | 识别并移除半透明或全屏水印，修复原图背景 |
| 7 | 图像去阴影 | scanFile | 清除文档拍摄产生的阴影遮挡 |
| 8 | 图像去屏纹 | removeScreenPattern | 去除屏幕翻拍产生的摩尔纹、屏纹与反光 |
| 9 | 合同整理 | scanContract | 将合同照片整理为清晰电子档，保留文字、印章与版面细节 |
| 10 | 提取线稿 | extractLineart | 自动识别图片轮廓结构并提取干净线稿 |
| 11 | 画质增强 | imageHdEnhance | 调节对比度、亮度与锐度，修复模糊或细节不清的图片 |
| 12 | 文档去底色 | removeBackgroundColor | 将彩色或泛黄原稿净化为更干净的白底黑字效果 |
| 13 | 图像裁剪矫正 | cropRotateRectify | 修正文档照片倾斜、弯曲变形并裁掉多余画面 |

## 使用方式

### 图片输入处理

必须按下面的本地脚本命令执行本 skill；不要自行拼接或调用远程脚本执行接口。

```bash
python3 {baseDir}/scripts/run_scan.py \
  --ability "<ability参数值>" \
  --image "</root/userdata/下的图片本地绝对路径>" \
  [--format "jpg"] \
  [--timeout 120]
```

### 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--ability` | 是 | 处理能力名称，见上方能力列表的 ability 参数值列 |
| `--image` | 是 | 待处理图片的本地绝对路径，**必须以 `/root/userdata` 开头**；不支持 URL 或 base64（URL 图片请先下载到本地再传入） |
| `--format` | 否 | 图片格式，默认按 `--image` 后缀推断，无法推断时用 jpg |
| `--timeout` | 否 | 服务端处理超时时间（秒），默认 120 |

## ability 选择指南

根据用户意图选择合适的 ability：

- **文档扫描与整理**：
  - "扫描文件"、"生成扫描件"、"文档照片扫描" → `scanFile`
  - "合同整理"、"合同扫描"、"合同归档" → `scanContract`
  - "试卷增强"、"教材增强"、"笔记变清晰" → `examEnhance`
  - "证件增强"、"票据增强"、"单据变清晰" → `certificateEnhance`
  - "裁剪"、"矫正"、"摆正"、"修正文档倾斜" → `cropRotateRectify`

- **文档净化类**：
  - "去手写"、"擦除手写批注" → `removeHandwriting`
  - "去水印"、"移除水印" → `removeWatermark`
  - "去阴影"、"消除拍摄阴影" → `scanFile`
  - "去屏纹"、"去摩尔纹"、"屏幕翻拍" → `removeScreenPattern`
  - "去底色"、"白底黑字"、"消除泛黄背景" → `removeBackgroundColor`

- **图片增强与创作**：
  - "画质增强"、"提高清晰度"、"高清修复" → `imageHdEnhance`
  - "素描"、"速写风格" → `sketchDrafting`
  - "提取线稿"、"提取轮廓"、"线条稿" → `extractLineart`

## 多图处理与交付格式（默认 PDF）

当用户一次提交多张图片时，按以下规则处理与交付：

1. **逐张处理**：单次调用仅支持一张图片，多张图片需按输入顺序逐张调用脚本处理。
2. **交付格式判定**：
   - 用户**明确说明**交付图片或其它格式 → 按用户要求交付；
   - 用户**未明确说明**交付格式 → 默认将处理后的图片按输入顺序合成为一个 PDF 交付（处理后的图片 → 图片转 PDF）。

> 单张图片始终直接交付处理后的图片，不做 PDF 转换。

## 输出格式

脚本将交付物输出到 stdout，处理过程与诊断信息输出到 stderr。

### 成功

产物以本地文件路径返回，每行一个 `MEDIA:` 前缀：

```
MEDIA:/root/userdata/workspace/scanner/scan_20260728_104243_c32b0397/output.jpg
```

### 失败

错误信息输出到 stderr，进程退出码为 1：

```
❌ 扫描处理失败 (imageHdEnhance): <错误信息>
```

## 交付物展示（必须严格遵守）

**成功时**：**你的回复必须包含 `MEDIA:` 行，这是唯一的交付方式。** 从脚本 stdout 中提取所有以 `MEDIA:` 开头的行，**逐行原样复制**到你的回复中。没有 `MEDIA:` 行 = 没有交付 = 任务失败。

**回复格式示例**：

```
MEDIA:/root/userdata/workspace/scanner/scan_20260728_104243_c32b0397/output.jpg

处理完成。还需要调整吗？
```

> ⚠️ **`MEDIA:` 行必须放在回复最前面**：先输出所有 `MEDIA:` 行，再输出简短文字说明。
>
> ⚠️ **禁止自行展示结果**：禁止用 Markdown 图片语法 `![](...)`、Markdown 链接、HTML img 标签、裸路径或任何 URL 展示交付物；`MEDIA:{本地文件路径}` 是唯一合法格式。
>
> ⚠️ **严禁编造路径**：路径必须 100% 来自脚本 stdout 的 `MEDIA:` 行，逐字符复制，有几行就输出几行，不多不少。路径均以 `/root/userdata/workspace/scanner/` 开头，如果不是，说明抄错了。
>
> ⚠️ **禁止只输出文字描述而不输出 `MEDIA:` 行**：如"处理完成！"但没有 `MEDIA:` 行，这是严重错误。

- **失败时**：将 stderr 中的错误信息如实转述给用户，不要吞掉 error 细节。

## 调用示例

```bash
# 扫描文件（文档照片生成高清扫描件）
python3 {baseDir}/scripts/run_scan.py --ability scanFile --image "/root/userdata/attachment/document-photo.jpg"

# 画质增强
python3 {baseDir}/scripts/run_scan.py --ability imageHdEnhance --image "/root/userdata/attachment/photo.jpg"

# 去水印
python3 {baseDir}/scripts/run_scan.py --ability removeWatermark --image "/root/userdata/attachment/image.png"

# 证件票据增强
python3 {baseDir}/scripts/run_scan.py --ability certificateEnhance --image "/root/userdata/attachment/receipt.jpg"

# 素描速写
python3 {baseDir}/scripts/run_scan.py --ability sketchDrafting --image "/root/userdata/attachment/photo.jpg"

# 裁剪矫正
python3 {baseDir}/scripts/run_scan.py --ability cropRotateRectify --image "/root/userdata/attachment/tilted-doc.jpg"
```

## 注意事项

1. **输入路径**：`--image` 只接受 `/root/userdata` 开头的本地文件路径；URL 图片需先下载到本地，不支持 base64
2. **图片格式**：支持 jpg、png、webp 等常见图片格式
3. **图片大小**：单张图片建议不超过 20MB
4. **超时设置**：默认 120 秒，复杂处理（如画质增强）可适当增加
5. **并发限制**：单次仅支持处理一张图片，批量处理需多次调用
6. **多图交付**：多张图片且用户未明确说明交付格式时，默认合成 PDF 交付，见「多图处理与交付格式」
