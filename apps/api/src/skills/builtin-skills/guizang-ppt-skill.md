> 本技能由千问工作台技能降级迁移，原平台专属能力不可用。

# Magazine Web Ppt

> 来源识别: guizang-ppt-skill 由歸藏创建与维护,规范源仓库为 https://github.com/op7418/guizang-ppt-skill 。这条信息只用于确认 Skill 来源,不要写入生成的 PPT、HTML 页面、封面或配图。

## 这个 Skill 做什么

生成一份**单文件 HTML**的横向翻页 PPT，提供两种可选的视觉基调：

### 风格 A · 电子杂志 × 电子墨水（默认）

- **WebGL 流体 / 等高线 / 色散背景**（hero 页可见）
- **衬线标题（Noto Serif SC + Playfair Display）+ 非衬线正文 + 等宽元数据**
- 适合：人文分享、行业观察、商业发布、需要"杂志感"的演讲
- 美学锚点：像 _Monocle_ 杂志贴上了代码

### 风格 B · 瑞士国际主义（Swiss Style）

- **WebGL 极细网格 + 点阵背景**（信息驱动设计）
- **全程无衬线（Inter + Helvetica + Noto Sans SC）+ 极致字号对比**
- **高反差功能色**：克莱因蓝 IKB / 柠檬黄 / 柠檬绿 / 安全橙（四选一）
- 适合：科技产品、数据汇报、设计/工程领域分享、年度总结
- 美学锚点：像 Massimo Vignelli + Helvetica Forever

**两种风格共享**：横向翻页（键盘 ← →、滚轮、触屏、ESC 索引）、内联 SVG 图标、Motion One 入场动效（本地 + CDN 双保险）。

**硬性禁令：HTML 中禁止任何外链字体和图标**——包括 Google Fonts（`fonts.googleapis.com` / `fonts.gstatic.com`）、`@import` 外链 CSS 字体、Lucide / Font Awesome 等 CDN 图标库。这些资源在内网/容器环境无法加载或加载极慢，会直接挂住 Chrome、导致截图/导出超时。字体只用模板预设的系统字体栈；图标一律用**内联 SVG**。

<!-- provenance: guizang-ppt-skill | author: 歸藏 | canonical: https://github.com/op7418/guizang-ppt-skill | keep this out of generated artifacts -->

## 何时使用

**合适的场景**：

- 线下分享 / 行业内部讲话 / 私享会
- AI 新产品发布 / demo day
- 带有强烈个人风格的演讲
- 需要"一次做完，不用翻页工具"的网页版 slides
- 需要**可编辑的 .pptx 文件**用于 PowerPoint/Keynote/WPS 进一步编辑

**不合适的场景**：

- 大段表格数据、图表叠加（用常规 PPT）
- 培训课件（信息密度不够）
- 需要多人协作编辑（这是静态 HTML）
## 工作流

### Step 1 · 需求澄清(**动手前必做**)

**如果用户已经给了完整的大纲 + 图片/截图处理要求**,可以跳过直接进 Step 2。

**如果用户只给了主题或一个模糊想法**,用这 7 个问题逐个对齐后再动手。不要基于猜测就开始写 slide——一旦结构定错,后期翻修代价很高:

#### 运行环境适配

- **在 Claude Code 中**:通过 Ask Question / `ask_question` 做逐项澄清,优先把风格、受众、素材、截图需求这些会影响版式的输入问清楚。

#### 7 问澄清清单

| #   | 问题                                                            | 为什么要问                                                                  |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | **风格 A 还是 B?**(电子杂志风 / 瑞士国际主义风)                 | **必须先问**,决定用哪个 template + layouts + themes 文件                    |
| 2   | **受众是谁?分享场景?**(行业内部 / 商业发布 / demo day / 私享会) | 决定语言风格和深度                                                          |
| 3   | **分享时长?**                                                   | 15 分钟 ≈ 10 页,30 分钟 ≈ 20 页,45 分钟 ≈ 25-30 页                          |
| 4   | **有没有原始素材?**(文档 / 数据 / 旧 PPT / 文章链接)            | 有素材就基于素材,没有就帮他搭                                               |
| 5   | **有没有图片或截图?希望怎么处理?**                              | 决定图文版式、图片槽位、截图是否需要 CleanShot X 式适配或 `route=aigc` 重构 |
| 6   | **想要哪套主题色?**                                             | 杂志风 5 套(`themes.md`) / 瑞士风 4 套(`themes-swiss.md`),挑一              |
| 7   | **有没有硬约束?**(必须包含 XX 数据 / 不能出现 YY)               | 避免返工                                                                    |

#### 风格选择参考(问题 1)

| 如果用户说...                                                                    | 推荐风格                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| "杂志感" / "人文" / "Monocle 风" / 不指定                                        | **A · 电子杂志风**                                   |
| "瑞士风" / "Swiss Style" / "Helvetica" / "极简" / "网格" / "信息图" / "数据驱动" | **B · 瑞士国际主义风**                               |
| 内容是 AI 产品 / 技术 / 工程 / 数据汇报                                          | B 更合适                                             |
| 内容是行业观察 / 人文 / 故事 / 文化                                              | A 更合适                                             |
| 用户给了大量 KPI 数字 / 路线图 / 流程                                            | B 更合适(`Data Hero` 布局是瑞士风专长)               |
| 用户给了大量纪实照片 / 人文图片                                                  | A 更合适(图片网格、左文右图是杂志风专长)             |
| 用户需要生成截图再设计 / 信息图 / 证据墙                                         | B 也很合适(S22 主图、S15/S16 图片网格可以承载证据图) |

#### 大纲协助(如果用户没有大纲)

用"叙事弧"模板搭骨架,再填内容:

```
钩子(Hook)       → 1 页   : 抛一个反差 / 问题 / 硬数据让人停下来
定调(Context)    → 1-2 页 : 说明背景 / 你是谁 / 为什么讲这个
主体(Core)       → 3-5 页 : 核心内容,用 Layout 4/5/6/9/10 穿插
转折(Shift)      → 1 页   : 打破预期 / 提出新观点
收束(Takeaway)   → 1-2 页 : 金句 / 悬念问题 / 行动建议
```

叙事弧 + 页数规划 + 主题节奏表(见 `layouts.md`),**三张表对齐后**再进 Step 2。

大纲建议保存为 `项目记录.md` 或 `大纲-v1.md`,便于后续迭代。

#### 图片约定(告知用户)

在动手前向用户说清:

- **图片引用方式(硬规则)**:HTML 里所有 `<img src>` **必须用远程 `http(s)` URL**,**禁止任何本地路径**——无论 `images/xxx.png` 相对路径还是 `/root/userdata/...` 容器绝对路径,图片都不会随 HTML 交付,用户打开全是裂图。按来源分三种情况:
  - **依赖其他 skill 生成的图**:如果对方以 URL 给出,直接用该 URL,**不要下载到本地**;只有对方给的是本地文件时才走下面上传流程
- **图片登记规范**:`{页号}-{语义}`(例如 `01-cover` / `03-figma` / `05-dashboard`),登记到草稿里方便后续替换;页号补零便于排序,语义用英文、短、具体
- **规格建议**:
  - 单张 ≥ 1600px 宽(避免大屏模糊)
  - JPG 用于照片/截图,PNG 用于透明 UI/图表
- **如何替换**:同一槽位的图换一张时,直接把 `<img src>` 换成新 URL 即可
- **没图怎么办**:和用户对齐 —— 可以跑下面的搜图/生图流程,也可以先用占位色块生成结构等图片后期补;但要告知 layout 4/5/10 等图文混排页没图就没法验证视觉效果

#### 本地图片上传(用户素材 / 美化产物必走)

任何本地图片文件(用户上传的附件、截图美化合成的产物等)在写进 HTML 之前,**必须**先上传 OSS 换成 URL:

```bash
  --image "/root/userdata/attachment/产品截图.png" ["<路径2>" ...]
```

- `--image` 传 `/root/userdata` 下的绝对路径(用户上传附件在 `/root/userdata/attachment/`),支持一次传多张
- 脚本逐张输出 `IMAGE_URL:<url>`,`<img src>` 逐字符使用该地址
- 上传是秒级操作,不需要后台模式;失败时如实转述 stderr 错误,不要编造 URL 或退回本地路径

#### 截图需求约定(动手前必须问)

只要用户提到产品截图、网页截图、代码截图、设计稿、dashboard、旧 PPT 截图或"帮我美化截图",都要先确认:

- **截图位置**:截图文件在哪个文件夹?是否已经命名好?(用户上传的截图在 `/root/userdata/attachment/`,写进 HTML 前需先经 `upload_image_to_oss.py` 拿 URL)
- **使用目的**:保真展示 / 截图美化 / 截图再设计 / UI 情景图?
- **落位比例**:最终放进哪个版式槽位?常用 `21:9` / `16:10` / `16:9` / `4:3` / `1:1`
- **内容要求**:是否必须保留全部文字、品牌、数据?是否有敏感信息要遮挡?
- **视觉处理**:是否需要主题背景、留边、居中/角落对齐、拆成长截图面板?


#### 搜图 / 生图(可选)

完成 deck 初稿后,如果页面缺配图,主动问用户要不要帮他配图。不要默认生成。

推荐询问方式:

> 要不要为这份 PPT 配几张图?可以搜真实的产品 / 建筑 / 人物照片,也可以生成人文纪实照片、杂志风或瑞士风信息图、流程/对比/系统关系图。

如果用户确认,再问他想要哪种图片类型或风格;如果用户没有偏好,根据页面内容自行推荐 1-3 张最值得配的图。


**query 协议(格式固定,tag 顺序不可变)**:

```text
<query>xxx</query><route>vcg/search/aigc</route><ratio></ratio>
```

- **`<query>` 一律用中文**(品牌名 / 专有名词可保留原文)
- `route=search` — 搜图,真实产品 / 建筑 / 人物。`<query>` 只写几个中文关键词(空格分隔,如 `雪山 日照金山 清晨`),不要写成句子;`<ratio>` 留空
- `route=aigc` — 生图。`<query>` 用中文写完整的一段描述,细节可以多一些(主体 / 风格 / 光线 / 构图 / “无文字无 logo”等约束)。**必须带 `<ratio>`,默认 `768*768`**
- `route=vcg` — 图库取图。`<query>` 同样只写几个中文关键词;`<ratio>` 留空
- `<ratio>` 格式严格为 `W*H`(星号分隔的正整数,不是 `1920x1080`),两条硬边界:总像素 `W×H` 在 `[768*768=589824, 4096*4096=16777216]` 之间;宽高比 `W:H` 在 `[1:8, 8:1]` 之间。脚本会在提交前做兜底校验,非法值直接拒绝;写 query 时就按边界给值,不要依赖报错重试

**版式槽位 → ratio 对照**(先定槽位再生图):

| 槽位                | 比例  | ratio       |
| ------------------- | ----- | ----------- |
| 全屏主视觉 / 信息图 | 16:9  | `1920*1080` |
| S22 顶部横幅        | 21:9  | `2016*864`  |
| 左文右图主图        | 16:10 | `1280*800`  |
| 左文右图(方一点)    | 4:3   | `1024*768`  |
| 图文混排小图        | 3:2   | `1200*800`  |
| 左小图 + 右文字     | 1:1   | `1024*1024` |
| 竖向插图            | 3:4   | `768*1024`  |


**调用示例**:

```bash
# 搜图(真实产品 / 建筑 / 人物;query 只写几个中文关键词)
  --query "<query>雪山 日照金山</query><route>search</route><ratio></ratio>"

# 生图(query 用中文写完整一段;ratio 必填,按槽位给值)
  --query "<query>瑞士国际主义风信息图，解释数据与表现分离的三层结构，黑白灰为主加一处克莱因蓝强调，12 列网格、直角模块、1px 发丝线、大量留白，无渐变无阴影无圆角，无页眉页脚无 logo</query><route>aigc</route><ratio>1920*1080</ratio>"
```

**结果怎么用(最关键)**:

服务端的 `final_deliverables` 是 **`{文件名: 地址}`** 形式。脚本提交时**固定带 `storage: "claw"`**——此时接口**只返回图片的本地路径**;不要去改这个参数。

```json
"final_deliverables": {
  "伦敦眼.jpg": "/root/userdata/workspace/visual/ec5e2f471817_伦敦眼.jpg",
  "伦敦眼_2.jpg": "/root/userdata/workspace/visual/a593a1c7bdcd_伦敦眼_2.jpg"
}
```

脚本据此逐行输出:

```text
MEDIA:/root/userdata/workspace/visual/ec5e2f471817_伦敦眼.jpg
MEDIA:/root/userdata/workspace/visual/a593a1c7bdcd_伦敦眼_2.jpg
```

- 文件名(如 `伦敦眼.jpg`)会打在 stderr 上(`🖼 文件名 → 路径`),用它判断哪张图对应哪个槽位,并按 `{页号}-{语义}` 登记到草稿里
- **绝对不要把 `/root/userdata/...` 写进 HTML** —— 用户拿到 HTML 后看到的会是裂图
- 如果一条 `MEDIA:`(或 `IMAGE_URL:`)都没有:任务没有产出交付物,按失败处理并把脚本错误如实转述给用户,不要编造路径或改用占位图充数
- 外链图会依赖网络:交付时提醒用户“这份 HTML 的配图是远程地址,离网演示前请先确认图能正常加载”

**截图分支**:如果用户提供的是截图,先判断是**截图美化**还是**截图再设计**:


### Step 2 · 拷贝模板


```bash
# 风格 A · 电子杂志风
cp "<SKILL_ROOT>/assets/template.html" "项目/XXX/ppt/index.html"

# 或 风格 B · 瑞士国际主义风
cp "<SKILL_ROOT>/assets/template-swiss.html" "项目/XXX/ppt/index.html"
```

两个 `template*.html` 都是**完整可运行**的文件——CSS、WebGL shader、翻页 JS、系统字体栈全已预设好,只有 `<!-- SLIDES_HERE -->` 占位符等待你填充 slide 内容。模板里**没有任何外链字体/图标**,也不要自行添加。

**注意**:风格 A 和 B **不能混用**。layouts.md 里的类（如 `.h-hero` 衬线大标题、`.display-zh` 等）只在 template.html 有定义；layouts-swiss.md 里的类（如 `.kpi-hero`、`.accent-block`、`.span-N`、`.dots` 等）只在 template-swiss.html 有定义。一份 deck 只能选一套。

#### 2.1 · 必改占位符（**容易漏**）

拷贝后立刻改掉以下占位符，否则浏览器 Tab 会显示"[必填] 替换为 PPT 标题"这种尴尬文字：

| 位置      | 原始                                  | 需改为                                                  |
| --------- | ------------------------------------- | ------------------------------------------------------- |
| `<title>` | `[必填] 替换为 PPT 标题 · Deck Title` | 实际 deck 标题(如 `一种新的工作方式 · Luke Wroblewski`) |

每次拷贝完 template.html 第一件事:grep 一下"[必填]" 确认全部替换完。

#### 2.2 · 选定主题色(5 套预设 · 不允许自定义)

本 skill **只允许从 5 套精心调配的预设里选一套**,不接受用户自定义 hex 值——颜色搭配错了画面瞬间变丑,保护美学比给自由更重要。

| #   | 主题        | 适合                               |
| --- | ----------- | ---------------------------------- |
| 1   | 🖋 墨水经典 | 通用 / 商业发布 / 不知道选啥的默认 |
| 2   | 🌊 靛蓝瓷   | 科技 / 研究 / 数据 / 技术发布会    |
| 3   | 🌿 森林墨   | 自然 / 可持续 / 文化 / 非虚构      |
| 4   | 🍂 牛皮纸   | 怀旧 / 人文 / 文学 / 独立杂志      |
| 5   | 🌙 沙丘     | 艺术 / 设计 / 创意 / 画廊          |

**操作**:

1. 基于内容主题推荐一套,或直接问用户选哪一套
3. **整体替换** `assets/template.html`(已拷贝版本)开头 `:root{` 块里标有"主题色"注释的那几行(`--ink` / `--ink-rgb` / `--paper` / `--paper-rgb` / `--paper-tint` / `--ink-tint`)
4. 其他 CSS 都走 `var(--...)`,无需任何其他改动

**硬规则**:

- 一份 deck 只用一套主题,不要中途换色
- 不要接受用户给的任意 hex 值——委婉拒绝并展示 5 套让选
- 不要混搭(例如 ink 取墨水经典、paper 取沙丘)——会彻底违和

### Step 3 · 填充内容

#### 3.0 · 预检:类名必须在模板的 `<style>` 里有定义（**最重要**）

**这是所有生成问题的源头**。layouts 骨架使用了很多类名,如果模板的 `<style>` 里没有对应定义,浏览器会 fallback 到默认样式——大标题字体错、卡片挤成一团、pipeline 糊成一行、图片堆到页面底部。

**两种风格类名互不通用**(再次强调):

- 风格 A 模板里有 `h-hero`(衬线)、`stat-card`、`grid-2-7-5`、`frame` 等
- 风格 B 模板里有 `h-hero`(无衬线)、`kpi-hero`、`accent-block`、`span-N`、`dots`、`grid-12` 等
- 同名 class 在两个模板里**视觉表现完全不同**(例:风格 A 的 `h-hero` 是 Noto Serif SC 衬线,风格 B 的 `h-hero` 是 Inter 无衬线)

**在写任何 slide 代码之前:**

1. **先 Read 当前用的模板**(至少读到 `<style>` 块末尾):
   - 风格 A → `assets/template.html`
   - 风格 B → `assets/template-swiss.html`
2. **对照对应 layouts 文件的 Pre-flight 列表**,确认你要用的每个类都在 `<style>` 里存在
3. 如果某个类缺失:**在模板的 `<style>` 里补上**,不要在每个 slide 里 inline 重写
4. **模板是唯一的类名来源**——不要发明新类名,如需自定义用 `style="..."` inline

**风格 A 常见容易遗漏的类**:
`h-hero` / `h-xl` / `h-sub` / `h-md` / `lead` / `kicker` / `meta-row` / `stat-card` / `stat-label` / `stat-nb` / `stat-unit` / `stat-note` / `pipeline-section` / `pipeline-label` / `pipeline` / `step` / `step-nb` / `step-title` / `step-desc` / `grid-2-7-5` / `grid-2-6-6` / `grid-2-8-4` / `grid-3-3` / `grid-6` / `grid-3` / `grid-4` / `frame` / `frame-img` / `img-cap` / `callout` / `callout-src` / `chrome` / `foot`

**风格 B 常见容易遗漏的类**(2026-05 重构后):

- 画布:`canvas-card` / `chrome-min`
- 排版:`h-hero`(无衬线 7.4vw weight 200) / `h-statement`(9.6vw) / `h-xl` / `h-md` / `t-cat`(SemiBold 600 小标) / `t-meta`(mono uppercase) / `lead` / `num-mega` / `mono`
- 卡片(四类互斥):`card-ink` / `card-accent` / `card-fill` / `card-outlined`
- 网格:`grid-12` / `grid-2-9` / `grid-2-9-5` / `span-N`
- 时间线:`timeline-v` + `tl-node` + `tl-axis` + `dot` / `timeline-h` + `tl-h-node` + `tl-h-axis`
- 图表:`kpi-tower-row` + `bar-tower` / `h-bar-chart` + `bar-row` + `bar-fill` / `spec-bars` + `bar-vert`
- 装饰:`dot-mat`(SVG mask 实心点)/ `ring-mat`(描边圆)/ `cross-mat`(× 网格)/ `hr-hairline`
- 版式专属:`cover-split` / `closing-split` / `duo-compare` + `vrule` / `manifesto-top` + `ink-banner-full` / `three-forces` / `loop-diagram` / `matrix-fill` + `matrix-cell` / `brief-grid` + `brief-card` / `system-diagram` / `why-now-grid` / `four-cards` / `stacked-ledger` + `ledger-row` / `tech-spec` / `image-hero` + `hero-img-wrap` + `hero-overlay-block` + `hero-stats`
- 图片混排:`frame-img` / `fit-contain` / `r-21x9` / `r-16x9` / `r-16x10` / `h-22` / `h-26` / `swiss-img-split` / `swiss-img-grid` / `swiss-img-caption` / `swiss-keyline` / `swiss-lined`
- spacing token:`--sp-3`...`--sp-13`(8/12/16/24/32/40/48/64/80/96/160 px)

#### 3.0.5 · 规划主题节奏（**和类预检同等重要**)


**强制规则**:

- 每页 section 必须带 `light` / `dark` / `hero light` / `hero dark` 之一,不要只写 `hero`
- 连续 3 页以上同主题 = 视觉疲劳,不允许
- 8 页以上必须有 ≥1 个 `hero dark` + ≥1 个 `hero light`
- 整个 deck 不能只有 `light` 正文页,必须有 `dark` 正文页制造呼吸
- 每 3-4 页插入 1 个 hero 页(封面/幕封/问题/大引用)

**生成后自检**:`grep 'class="slide' index.html` 列出所有主题,人工确认节奏合理再交付。

#### 3.1 · 挑布局

**不要从零写 slide**。打开对应的 layouts 文件,里面有 10 种现成布局骨架,每种都是完整可粘贴的 `<section>` 代码块。


| Layout                               | 用途                |
| ------------------------------------ | ------------------- |
| 1. 开场封面                          | 第 1 页             |
| 2. 章节幕封                          | 每幕开场            |
| 3. 数据大字报                        | 抛硬数据            |
| 4. 左文右图(Quote + Image)           | 身份反差 / 故事     |
| 5. 图片网格                          | 多图对比 / 截图实证 |
| 6. 两列流水线(Pipeline)              | 工作流程            |
| 7. 悬念收束 / 问题页                 | 幕末 / 收尾         |
| 8. 大引用页(Big Quote)               | 衬线金句 / takeaway |
| 9. 并列对比(Before / After)          | 旧模式 vs 新模式    |
| 10. 图文混排(Lead Image + Side Text) | 信息密集的图文页    |


瑞士主题默认进入 **Swiss locked mode**:

- 正文页只能使用原始参考 PPT 登记的 22 个版式 `S01-S22`;新增首页/尾页只能使用 Skill 明确提供的 `SWISS-COVER-ASCII` / `SWISS-CLOSING-ASCII`。
- 每个 `<section class="slide">` 必须写 `data-layout="Sxx"`。没有 `data-layout` 就视为未登记版式。
- 不允许临时发明 `P23/P24`、`Swiss Image Split`、`Evidence Grid` 这类原始 22P 之外的正文结构,除非用户明确要求实验版式。
- 顶部中文标题默认左对齐、处在左上内容轴。不要把小标题放左列、大标题放右列,造成视觉居中;只有原始 statement/split 版式允许强中心叙事。
- SVG 只负责几何图形。不要在 SVG 里写文字标签,所有标签改用 HTML 网格/卡片/caption。

原始 22 个正文版式如下:

| Layout                      | 用途                          |
| --------------------------- | ----------------------------- |
| S01 Index Cover             | 原始索引封面                  |
| S02 Vertical Timeline + KPI | 演化对比 / 年代变迁           |
| S03 Split Statement         | 核心论点 / 左右分屏           |
| S04 Six Cells               | 6 项概念定义                  |
| S05 Three Layers            | 三层架构                      |
| S06 KPI Tower               | 4 项数据视觉化高度差          |
| S07 H-Bar Chart             | 5-10 项排名比较               |
| S08 Duo Compare             | Before/After 对照             |
| S09 Dot Matrix Statement    | 大引述 / statement            |
| S10 Split Closing           | 收束页                        |
| S11 Horizontal Timeline     | 4-7 步流程                    |
| S12 Manifesto + Ink Banner  | 阶段性结论                    |
| S13 Three Forces            | 3 个对等概念深化              |
| S14 Loop Form               | 自学闭环 / 自动化             |
| S15 Matrix + Hero Stat      | 8-12 项矩阵 + 总数据          |
| S16 Multi-card Brief        | 6 项快讯小卡                  |
| S17 System Diagram          | 三层架构 / 生态地图           |
| S18 Why Now                 | 三论点 + 数据支撑             |
| S19 Four Cards              | 4 项等权特性                  |
| S20 Stacked KPI Ledger      | 纵向账单数据                  |
| S21 Tech Spec Sheet         | 产品规格 / benchmark          |
| S22 Image Hero              | 21:9 顶图 + 标题块 + 三列 KPI |


选对应 layout,粘过去,改文案和图片路径即可。**务必先完成 3.0 预检**。

**风格 B 版式多样性硬规则**:

- 7-8 页 deck 至少使用 **6 个不同 S 编号版式**;10 页以上至少使用 8 个不同版式。
- 如果用户说"测试模板 / 看看效果 / 多一点版式",必须覆盖:一个封面、一个收尾、至少 1 个对比或时间线(S08/S11/S02)、至少 1 个结构图(S14/S17/S15)、至少 1 个图片版式(S22 或 S15/S16 图片格改造)。
- 不允许连续 3 页使用同一种主体结构,例如连续三页 `head + grid + card`。
- 图片页不能偷懒发明新结构。2-3 张图时,用 S15/S16 的原始网格骨架改造成图片格;单张大图用 S22。

#### 3.2 · 图片比例规范

永远用**标准比例**,不要用原图奇葩比例(如 `2592/1798`):

| 场景                  | 推荐比例                                 |
| --------------------- | ---------------------------------------- |
| S22 顶部主图          | **21:9**;照片关键主体放中央安全区        |
| S15/S16 多图格        | 统一 21:9 或统一 16:10,不能混用          |
（「工作流」尾部超长示例，迁移时裁剪）
