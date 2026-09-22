
# HTML Prototype Generator

快速生成可交互的 HTML 原型图，支持移动端/桌面端/平板端，支持高保真与低保真风格。

## 输入

```text
$ARGUMENTS
```

### 输入示例

```text
/html-prototype 
移动端高保真资助申请页：
1. 顶部：用户信息卡片，头像 + 姓名 + 账号
2. 中部：申请流程进度条（用户申报 → 平台审核 → 资金发放）
3. 底部：项目列表，包含"资助项目1"和"资助项目2"两个并列卡片，各有"立即申请"按钮
```



## 执行流程

### Step 1：解析参数

从 `$ARGUMENTS` 或对话上下文中提取以下参数。未指定的使用默认值。

| 参数 | 说明 | 默认值 |
|------|------|--------|
| device | 设备类型：mobile / desktop / tablet | mobile |
| fidelity | 保真度：high（高保真真实配色）/ low（低保真灰白线框）| high |
| theme | 主题色（十六进制色值或色名） | #FF6600 |
| filename | 输出文件名 | prototype-{name}.html |

**设备尺寸规范：**
- mobile: 375×812（iPhone 标准）
- tablet: 768×1024（iPad 标准）
- desktop: 1440×900（桌面标准）

**文件名规则：** 从需求中提取核心名词转为 kebab-case，并追加版本号后缀 `-v{N}`。
- 首次生成：扫描 `{{当前工作区}}/prototype-html/` 目录下同名前缀文件，取最大版本号 +1；若无同名文件则从 `v1` 开始。
- 示例："骑士救助申请页" → `prototype-knight-rescue-v1.html`，再次生成 → `prototype-knight-rescue-v2.html`

### Step 2：确定输出路径

生成的 HTML 文件输出到当前工作区的 `prototype-html` 目录。如果该目录不存在，则先创建：
```
{{当前工作区}}/prototype-html/{filename}
```

### Step 3：上下文收集

- **描述足够明确**：直接生成（如"一个登录页，有账号密码输入框和登录按钮"）
- **涉及项目上下文**：先读取项目代码/接口/数据模型，用真实字段名生成（如"我们项目的骑士申请页"）
- **判断标准**：如果需求中包含"我们的"、"项目中的"、"现有的"等上下文引用词，先读代码

### Step 4：读取参考资源

1. 读取 `references/html-boilerplate.md` 获取 HTML 基础模板
2. 读取 `references/components.md` 获取可用的 UI 组件参考

### Step 5：生成 HTML

遵循以下规则生成单文件 HTML：

#### 5.1 基础规范
- **单文件**：所有 CSS 和 JS 内联，不依赖外部资源（CDN 图标库除外）
- **图标**：使用 Material Icons CDN `https://fonts.googleapis.com/icon?family=Material+Icons`
- **字体**：系统字体栈 `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- **占位图**：使用纯色块 + 图标代替，不引用外部图片 URL

#### 5.2 间距系统（借鉴 wireframe Skill）
```
4px  - 极紧凑（图标与文字间距）
8px  - 紧凑（列表项内部）
12px - 常规（元素间距）
16px - 宽松（卡片内边距）
24px - 区块间距
40px - 大区块分隔
```

#### 5.3 高保真模式（fidelity=high）
- 使用 theme 主题色 + 渐变 + 圆角(8px-16px) + 投影(box-shadow)
- 卡片式布局，真实配色方案
- 按钮有 hover 状态变化
- 使用 Material Icons 图标
- 占位图用渐变色块 + 居中图标表示

#### 5.4 低保真模式（fidelity=low）
- 黑白灰配色，仅用 #333 #666 #999 #ccc #f5f5f5 #fff
- 无圆角、无投影、无渐变
- 边框用 2px dashed #ccc
- 文本区域用灰色块占位
- 手绘风格字体（可选 'Comic Neue' CDN）

#### 5.5 响应式
- 使用 viewport meta 标签
- mobile 模式下 `max-width: 375px; margin: 0 auto;`
- desktop 模式下 `max-width: 1440px; margin: 0 auto;`
- 使用 flexbox / grid 布局

#### 5.6 交互能力
- Tab 切换：用纯 CSS 或少量 JS 实现
- 按钮点击：`onclick` 弹出简单 toast 或切换状态
- 折叠展开：用 `<details><summary>` 或 JS toggle
- 轮播/滑动：简单 CSS 动画即可，不要过度复杂

### Step 6：质量校验

生成后自检：
- [ ] 无外部图片引用（占位图用色块代替）
- [ ] 无未闭合标签
- [ ] 无 smart quotes（智能引号）出现在 HTML 属性中
- [ ] 间距系统一致（遵循 Step 5.2）
- [ ] mobile 模式下在 375px 宽度内不溢出
- [ ] 所有可点击元素有 `cursor: pointer`
- [ ] 低保真模式下无彩色元素

### Step 7：输出与提示

1. 将 HTML 文件写入 `{{当前工作区}}/prototype-html/` 目录（若目录不存在则先创建）
2. 告知用户文件路径，提示可在浏览器中直接打开预览
3. 询问是否需要调整

## 迭代修改规则

用户后续提出修改时：
- **读取现有 HTML 文件**，在其基础上修改，不要从零重写
- **保留用户已确认的部分**，仅修改指定区域
- **每次修改后**重新执行 Step 6 质量校验

## 状态覆盖（借鉴 Wireframe Creator）

当用户要求"生成完整状态"时，为关键组件生成多状态：
- **normal**：正常数据展示
- **empty**：空数据/无内容状态
- **loading**：加载中骨架屏
- **error**：异常/报错状态

每种状态生成为同一 HTML 文件中的不同 tab 或 section，方便对比。

## 提示词模板

如果用户需求描述较模糊，引导用户补充以下信息：

```
请补充以下信息以生成更精准的原型：
1. 设备类型：移动端 / 桌面端 / 平板端？
2. 页面风格：高保真（接近真实 UI）/ 低保真（线框草图）？
3. 页面结构：请按区块描述，格式如下：
   - 区块1：[名称] - [包含的元素] - [交互行为]
   - 区块2：[名称] - [包含的元素] - [交互行为]
   ...
4. 特殊要求：主题色 / 品牌风格 / 参考页面？
```

## 快速示例

```
/html-prototype 

移动端高保真资助申请页：
1. 顶部：用户信息卡片，头像 + 姓名 + 账号
2. 中部：申请流程进度条（用户申报 → 平台审核 → 资金发放）
3. 底部：项目列表，包含"资助项目1"和"资助项目2"两个并列卡片，各有"立即申请"按钮
```
