# atxp2-worker

将 [chat.atxp.ai](https://chat.atxp.ai) 转换为 OpenAI 兼容 API 的 Cloudflare Worker。

支持模型：Claude、GPT、Gemini、Grok、DeepSeek（由 ATXP 端点提供）。

## 部署

### 前置条件

- [Node.js](https://nodejs.org) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（`npm install -g wrangler`）
- Cloudflare 账号

### 步骤

**1. 克隆仓库**

```bash
git clone https://github.com/your-username/atxp2-worker.git
cd atxp2-worker
npm install
```

**2. 登录 Cloudflare**

```bash
npx wrangler login
```

**3. 创建 D1 数据库**

```bash
npx wrangler d1 create atxp2
```

将输出的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "atxp2"
database_id = "你的-database-id"
```

**4. 初始化表结构**

```bash
npx wrangler d1 migrations apply atxp2 --remote
```

**5. 设置 Secrets**

```bash
npx wrangler secret put API_KEY    # 客户端鉴权用，留空则无需认证
npx wrangler secret put ADMIN_KEY  # 管理接口鉴权用
```

**6. 部署**

```bash
npx wrangler deploy
```

### 自动部署（GitHub Actions）

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加以下两个 Secret：

- `CLOUDFLARE_API_TOKEN`：在 [CF Dashboard](https://dash.cloudflare.com/profile/api-tokens) 用 **Edit Cloudflare Workers** 模板创建
- `CLOUDFLARE_ACCOUNT_ID`：在 [CF Dashboard](https://dash.cloudflare.com/) 右侧边栏或 Workers 页面可找到 Account ID

之后 push 到 `main` 分支自动触发部署。

## 导入账号

账号需通过本地 [register.py](https://github.com/bwwq/atxp2) 注册后导入。注册完成后，打开 Worker 根路径的管理界面（`https://your-worker.workers.dev/`），在「导入账号」中粘贴 JSON 批量导入。

也可通过 API 导入：

```bash
curl -X POST https://your-worker.workers.dev/admin/import \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '[{"email":"user@example.com","refresh_token":"xxx"}]'
```

`accounts.json` 格式：

```json
[
  { "email": "user@example.com", "refresh_token": "xxx" }
]
```

## API

Base URL：`https://atxp2.your-subdomain.workers.dev`

| 端点 | 说明 |
|------|------|
| `POST /v1/chat/completions` | 对话（兼容 OpenAI 格式，支持 stream） |
| `POST /v1/messages` | 对话（兼容 Anthropic 格式，支持 stream） |
| `GET /v1/models` | 获取可用模型列表 |
| `GET /status` | 账号池状态 |
| `GET /admin/accounts` | 查看账号列表 |
| `POST /admin/accounts` | 添加单个账号 |
| `POST /admin/import` | 批量导入账号 |
| `DELETE /admin/accounts/:email` | 删除账号 |

请求头（设置了 API_KEY 时必须携带）：

```
Authorization: Bearer YOUR_API_KEY
```

## 可用模型

| 模型 ID | 提供商 |
|---------|--------|
| `anthropic/claude-opus-4-6` | Anthropic |
| `anthropic/claude-sonnet-4-6` | Anthropic |
| `anthropic/claude-haiku-4-5` | Anthropic |
| `openai/gpt-5.2` | OpenAI |
| `openai/gpt-5.2-pro` | OpenAI |
| `openai/gpt-5.2-codex` | OpenAI |
| `openai/o4-mini` | OpenAI |
| `google-ai-studio/gemini-3.1-pro-preview` | Google |
| `google-ai-studio/gemini-flash-latest` | Google |
| `grok/grok-4` | xAI |
| `grok/grok-4-1-fast` | xAI |
| `grok/grok-3-mini` | xAI |
| `deepseek/deepseek-v3.2` | DeepSeek |

也可调用 `GET /v1/models` 获取实时列表。

## License

MIT
