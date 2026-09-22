
# Financial Reports Fetcher

查找财报和研究报告的下载链接。财报类使用 browser-skill 从指定站点获取，其余类优先使用 search 技能搜索，若 search 无结果再用 browser-skill 从券商/研究机构官网查找。不执行实际下载。

## 支持的报告类型

### 公司财报

- 季报（10-Q）、年报（10-K）、盈利公告
- 美股、港股、A股上市公司财务报告

### 研究报告

- 券商研报、投研报告
- 行业研究报告、行业分析报告
- 市场调研报告

## 报告类型分流

> 不同类型报告的查找方式不同：

| 报告类型 | 推荐技能 | 说明 |
| --- | --- | --- |
| **财报类** | `browser-skill` | 季报、年报、10-Q、10-K、业绩报告、盈利公告等官方财报，需从指定站点（公司IR页、SEC、交易所）获取 |
| **其他所有类型** | `search` → `browser-skill` | 券商研报、投研报告、行业研究报告、行业分析报告、招股书等，优先使用 search 技能（不是 ra_search 技能）搜索下载链接；若 search 无结果，再使用 browser-skill 从券商/研究机构官网查找 |

**示例**：
- "下载贵州茅台2023年年报" → 使用 `browser-skill`
- "找一份新能源汽车行业研究报告" → 优先使用 `search`，无结果再用 `browser-skill`

## 工作流程

> ⚠️ **注意**：本 skill 内部调用 browser-skill 或者 search skill 完成任务，可能需要 **数分钟到 10 分钟** 完成，调用后请耐心等待，不要中断。

### 1. 判断报告类型并分流

根据用户请求判断报告类型：
- **财报类**（季报、年报、10-Q、10-K、业绩报告、盈利公告）→ 使用 browser-skill，继续下方流程
- **其他类**（券商研报、投研报告、行业研究、行业分析）→ 优先使用 search 技能搜索下载链接；若 search 无结果，再使用 browser-skill 继续下方流程

### 2. 确定查找目标

询问用户：

- 目标公司（股票代码/公司名称）
- 报告类型（季报/年报）
- 时间范围（最近几季度/特定年份）

### 3. 定位官方来源

**重要：不在此列表中的公司，必须先用 search skill 搜索获取 IR 页面链接。**

查看 references/ir-pages.md 中的常见公司列表。如果目标公司不在列表中：

1. 调用 search skill 搜索 `{公司名} investor relations earnings report IR page`
2. 从搜索结果中提取官方投资者关系网站 URL
3. 验证 URL 有效后再调用 browser-skill

优先访问以下官方渠道：

| 来源               | URL 模式                     | 适用场景           |
| ------------------ | ---------------------------- | ------------------ |
| 公司投资者关系网站 | company IR page              | 公司财报，PDF 完整 |
| SEC EDGAR          | sec.gov/cgi-bin/browse-edgar | 美股官方 10-Q/10-K |
| HKEX 披露易        | hkexnews.hk                  | 港股公告           |
| 上交所/深交所      | sse.com.cn / szse.cn         | A股公告            |
| Globe Newswire     | globenewswire.com            | 美股新闻稿         |
| 券商研报中心       | broker website               | 券商研究报告       |
| 第三方研究机构     | research institute           | 行业研究报告       |
| 咨询公司官网       | consulting firm              | 市场调研报告       |

**常见研究报告来源：**

- 券商研报：中信证券、中金公司、华泰证券等券商官网研报中心
- 行业研究：艾瑞咨询、易观分析、QuestMobile、艾媒咨询
- 国际机构：麦肯锡、波士顿咨询、高盛研究、摩根士丹利研究

**常见公司 IR 页面：**

- 阿里巴巴: alibabagroup.com/cn/ir/reports
- 拼多多: investor.pddholdings.com
- 京东: ir.jd.com
- 腾讯: tencent.com/en-us/investors.html
- 百度: ir.baidu.com

### 4. 使用 browser-skill 获取下载链接

调用 browser-skill 的 `new_run_task` 执行链接查找任务：

```bash
python scripts/new_run_task.py \
    --task "访问 [IR网站URL]，找到 [时间范围] 的 [报告类型]，收集所有PDF下载链接并返回。" \
    --url "[起始URL]" \
    --output json
```

**示例：**

```bash
python scripts/new_run_task.py \
    --task "访问拼多多投资者关系网站，找到2025年四个季度的财报PDF链接，返回每份报告的标题和直接下载链接。" \
    --url "https://investor.pddholdings.com/" \
    --output json
```

### 5. 处理登录中断

如果 browser-skill 返回 `login_required: true`：

- **二维码登录**: 提示用户扫描保存的二维码图片
- **手机验证码**: 引导用户提供手机号和验证码
- **手动登录**: 提供远程桌面链接或让用户本地操作

用户完成登录后，重新运行 task 并标注"已完成登录"。

### 6. 输出结果

返回以下信息：

- 报告标题及对应的官方下载链接（直接 PDF URL）
- 备用下载渠道（如 SEC EDGAR 链接）
- 链接来源页面（便于用户自行验证）

## 任务描述最佳实践

**明确指定：**

- 目标公司股票代码（如 PDD、BABA、JD）
- 具体季度/年份（如“2025年Q1-Q4”）
- 报告类型（季报/年报/盈利公告）

**示例任务描述：**

```
访问阿里巴巴投资者关系网站 alibabagroup.com/cn/ir/reports，
找到2025年四个季度的季度财报PDF文件（Quarterly Results），
返回每个文件的标题和直接下载链接。
```

## 常见问题处理

| 问题               | 解决方案                                      |
| ------------------ | --------------------------------------------- |
| CDN/反爬虫拦截     | 使用 browser-skill（已内置反爬绕过）          |
| SEC EDGAR 限制     | browser-skill + 合理 User-Agent               |
| 需要登录           | 引导用户手动完成登录                          |
| PDF 链接不直接暴露 | 让 browser-skill 点击下载按鈕获取真实链接 URL |
| 中文网站乱码       | browser-skill 自动处理编码                    |

## References

- [browser-skill 使用指南](../browser-skill/SKILL.md)
- 常见公司 IR 页面列表: 见 references/ir-pages.md
