
# Image Search（图片搜索）

**功能定位：从现有图库中检索已有图片。** 适用于用户需要查找、筛选已有图片资源的场景。

## 使用方式

当用户需要**从图库中查找/检索已有图片**时使用：

```bash
GATEWAY_DOMAIN=$(python3 -c "import json; print(json.load(open('/app/claw_config.json'))['gateway_domain'])")
source {baseDir}/../_lib/openclaw_sign.sh
openclaw_curl -X POST --max-time 30 "${GATEWAY_DOMAIN}/api/proxy/search/api/v1/image/search" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: search-dev-abc123" \
  -d '{
    "query": "<用户搜索关键词>",
    "task_description": "<用户描述的使用场景或用途>",
    "max_num_results": 10
  }'
```

### 参数说明

| 参数               | 类型   | 必填 | 说明                                         |
| ------------------ | ------ | ---- | -------------------------------------------- |
| `query`            | string | 是   | 图片搜索关键词，使用用户原始输入             |
| `task_description` | string | 否   | 图片使用场景描述，帮助返回更精准的结果       |
| `max_num_results`  | number | 否   | 返回图片数量上限，默认10，最大不超过20       |

## 示例

| 用户请求                                         | query参数        | task_description参数         |
| ------------------------------------------------ | ---------------- | ---------------------------- |
| "帮我找几张人工智能的配图，用于技术博客封面"     | "人工智能"       | "技术博客封面配图"           |
| "搜索一些自然风景图片"                           | "自然风景"       | ""                           |
| "找5张适合PPT的科技感图片"                       | "科技感"         | "PPT背景图片"                |
| "有没有熊猫的高清图"                             | "熊猫高清"       | ""                           |

## 注意事项

- **适用场景**：用户要「找」「搜」「查」已有图片，而非「生成」「创作」新图片
- **query参数**：直接使用用户的搜索关键词，不要修改或拆解
- **task_description参数**：根据用户描述的使用场景填写，若无明确场景可留空
- **只调用一次**：每次请求只调用API一次
- **结果数量**：`max_num_results` 默认为10，可根据用户需求调整，最大不超过20