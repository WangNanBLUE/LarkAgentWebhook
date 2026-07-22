# 竞品分析飞书 Agent

本机常驻的 Node.js 服务。它通过 `lark-cli` 长连接接收群内 `@竞品分析` 消息，调用 OpenAI Responses API 的受控工具查询 `竞品书籍快照`，并在确认后维护独立的 `竞品书籍 AI 分析看板`。

## 要求

- Node.js 22+
- `lark-cli` 1.0.74+
- 飞书应用“竞品分析”已开启机器人能力
- 应用已订阅 `im.message.receive_v1`
- 应用已开通群聊 @ 消息、`im:message:send_as_bot` 以及目标 Base 读写权限
- 机器人已加入目标群，且应用或机器人对目标 Base 有完全访问权限
- 自定义模型端点支持 OpenAI Responses API 和 function calling

## 配置飞书应用

在本项目目录创建独立 profile。App Secret 通过 stdin 输入，不要放在命令参数或仓库中：

```bash
printf '%s' "$COMPETITOR_APP_SECRET" | lark-cli config init \
  --name competitor-analysis \
  --app-id "$COMPETITOR_APP_ID" \
  --app-secret-stdin \
  --brand feishu

lark-cli config strict-mode bot
lark-cli whoami
```

`whoami` 必须显示 `identity: "bot"`，且 `appId` 是“竞品分析”应用。启动预检若返回 `missing_scopes`，按错误里的 `console_url` 在开发者后台开通权限，不要执行用户授权登录。

## 配置模型

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

```dotenv
OPENAI_BASE_URL=https://your-provider.example/v1
OPENAI_API_KEY=...
OPENAI_MODEL=...
LARK_EXPECTED_APP_ID=cli_your_competitor_analysis_app
```

Node 不会自动读取 `.env`。开发时使用：

```bash
npm install
node --env-file=.env --import tsx src/index.ts
```

或先在 Shell / PM2 环境中导出这些变量。

## 运行

```bash
npm test
npm run check
npm run build
node --env-file=.env dist/src/index.js
```

健康检查仅监听本机：

```bash
curl http://127.0.0.1:8787/healthz
```

PM2：

```bash
npm install -g pm2
npm run build
set -a && source .env && set +a
pm2 start ecosystem.config.cjs
pm2 save
```

## 群内用法

```text
@竞品分析 最新快照中，阅读量最高的 10 本书是什么？
@竞品分析 按书籍来源创建一个环形图
```

新增或修改组件时，机器人先回复预览。发起人需要在同一话题中发送：

```text
@竞品分析 确认
```

确认在 10 分钟后过期。其他成员不能确认该提案。

## 安全边界

- 模型只能调用固定的查询和组件提案工具。
- 模型不能执行 Shell、任意 HTTP、删除操作或直接写看板。
- 写入参数在预览时冻结，确认阶段不再次调用模型。
- 只管理服务登记的 AI 看板组件，不修改原看板的 dashboard-v2 组件。
