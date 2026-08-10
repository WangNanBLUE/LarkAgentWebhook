# 通用飞书数据 Agent

本机常驻的 Node.js 服务。机器人通过 `lark-cli` 以应用身份接收飞书消息，使用 OpenAI Responses API 分析用户本轮提供的文本及飞书数据，并在交互确认后修改云文档或 Base 看板组件。

## 工作方式

1. 私聊消息会直接处理；群聊消息仅在机器人被 `@` 时处理。
2. 用户回复一条消息时，机器人会读取最多 6,000 字的引用消息作为不可信上下文。
3. Agent 只注册本轮消息中的文本和飞书链接，以不透明的 `source_id` 读取数据。
4. 只读分析直接回复。写入请求先生成 10 分钟有效的交互确认卡。
5. 只有发起人可以确认或取消。确认后服务使用提案时冻结的参数执行，不再调用模型改写参数。
6. 私聊和群聊都引用回复原消息；群聊回复会 `@` 发起人，不创建话题。

默认使用 CardKit 流式卡片展示读取、查询和总结状态。卡片不可用时自动回退为普通文本回复。

## 支持范围

| 输入或操作 | 支持情况 |
| --- | --- |
| 消息文本 | 支持，单条最多 20,000 字 |
| 云盘文件夹 | 读取最多 200 个直接子项，不递归读取正文 |
| Docx 文档 | 读取、新建、追加、替换指定块 |
| Wiki 链接 | 解析后读取对应 Docx 或 Sheets |
| Sheets 电子表格 | 读取工作簿、工作表和指定范围 |
| Base 多维表格 | 读取表结构、记录和聚合数据 |
| Base 看板 | 查看组件，创建组件，修改已有组件 |
| 图片、附件、普通文件 | 暂不支持 |
| Sheets 写入 | 暂不支持 |
| 搜索云空间或自动发现文件 | 不支持 |
| 删除看板组件或新建看板 | 不支持 |

资源限制：

- 每条消息最多包含 5 个飞书链接。
- 单个来源最多向模型返回 60,000 字，本轮所有来源合计最多 120,000 字。
- Base 单次查询最多返回 200 行。
- 只接受 HTTPS 的 `feishu.cn` 及其子域名中的云盘文件夹、Docx、Wiki、Sheets 和 Base 链接。
- 来源内容中的链接、指令和工具调用要求均不会扩展本轮权限。

## 写入保护

下列操作必须经过交互卡确认：

- 新建云文档。
- 向用户提供的 Docx 追加内容或替换指定块。
- 在用户提供的 Base 看板中创建组件。
- 修改用户提供的 Base 看板中的已有组件。

提案会记录发起人、聊天、目标资源和原始版本。确认时如果文档 revision、目标块或看板组件配置已变化，服务会拒绝执行并要求重新生成提案。执行结果不明确时不会自动重试，以避免重复创建。

## 前置条件

- Node.js 22 或更高版本。
- 已安装并配置 `lark-cli`。
- 支持 Responses API、流式输出和函数工具调用的模型端点。
- 飞书应用已开启机器人能力并发布可用版本。
- Docx、Sheets、Base 等目标资源已显式共享给该应用。

飞书应用需订阅以下事件：

- `im.message.receive_v1`
- `card.action.trigger`

应用还需具备机器人收发消息、读取消息、CardKit 卡片、Docx/Wiki 读取与编辑、Sheets 读取，以及 Base 表结构、记录和看板组件读写权限。具体权限名称以飞书开放平台对应 API 的权限提示为准。

## 配置应用身份

本服务只使用飞书应用身份，不使用或回退到用户 OAuth。将 `lark-cli` 切换到目标应用后启用 bot 严格模式：

```bash
lark-cli config strict-mode bot
lark-cli whoami
```

`whoami` 必须满足：

- `identity` 为 `bot`
- `available` 为 `true`
- `appId` 与 `LARK_EXPECTED_APP_ID` 一致

服务启动时会再次校验这些条件，校验失败会直接退出。

## 环境变量

```bash
cp .env.example .env
```

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `OPENAI_BASE_URL` | 是 | - | OpenAI 兼容 API 地址，需包含 `/v1` |
| `OPENAI_API_KEY` | 是 | - | 模型 API Key |
| `OPENAI_MODEL` | 是 | `gpt-5.6` | 支持 Responses API 和工具调用的模型 |
| `LARK_CLI_BINARY` | 否 | `lark-cli` | `lark-cli` 可执行文件路径 |
| `LARK_EXPECTED_APP_ID` | 是 | - | 启动时校验的飞书应用 App ID |
| `LARK_BOT_NAME` | 否 | `竞品分析` | 用于识别群聊中的机器人 `@` |
| `LARK_BOT_OPEN_ID` | 否 | - | 机器人 Open ID；配置后优先用于 `@` 匹配 |
| `LARK_RESPONSE_MODE` | 否 | `streaming_card` | `streaming_card` 或 `text` |
| `AGENT_TIMEOUT_MS` | 否 | `180000` | 单次 Agent 总超时，范围 60-600 秒 |
| `AGENT_FINAL_RESPONSE_RESERVE_MS` | 否 | `60000` | 为最终总结预留的时间，范围 10-120 秒 |
| `STATE_PATH` | 否 | `./data/agent.sqlite` | 去重、会话和待确认操作的 SQLite 文件 |
| `HEALTH_HOST` | 否 | `127.0.0.1` | 健康检查监听地址 |
| `HEALTH_PORT` | 否 | `8787` | 健康检查端口 |

以下变量仅用于兼容旧的“竞品书籍”无链接请求，建议新部署不配置：

- `LARK_BASE_TOKEN`
- `LARK_TABLE_ID`
- `LARK_TABLE_NAME`
- `LARK_SNAPSHOT_FIELD`
- `LARK_DASHBOARD_NAME`

仅当 `LARK_BASE_TOKEN` 和 `LARK_TABLE_ID` 同时存在，且当前消息没有飞书链接并明确包含竞品或书籍分析意图时，服务才会注入该默认来源。

## 安装与运行

```bash
npm install
npm test
npm run check
npm run build
node --env-file=.env dist/src/index.js
```

开发模式：

```bash
node --env-file=.env --import tsx src/index.ts
```

服务启动后会长期消费消息和卡片事件。事件连接中断时会自动重连，重试间隔从 1 秒指数增加到最多 30 秒。收到 `SIGINT` 或 `SIGTERM` 时，服务会停止接收事件并等待当前处理任务退出。

## 健康检查

```bash
curl http://127.0.0.1:8787/healthz
```

服务只有在 SQLite、飞书身份和两个事件消费者均就绪后才处于完整可用状态。若事件消费者断开，健康信息会包含降级原因，并在重连成功后恢复。

## 群组固定来源

群聊内任何成员都可以为该群固定最多 5 个分析来源：

```text
@竞品分析 固定来源 https://tenant.feishu.cn/docx/... https://tenant.feishu.cn/base/...
@竞品分析 查看固定来源
@竞品分析 解绑来源 https://tenant.feishu.cn/docx/...
@竞品分析 清空固定来源
```

固定来源支持 Docx、Wiki、Sheets 和 Base，并持续生效直到有人显式解绑。后续群成员正常 `@机器人` 分析时，服务会自动加入本群固定来源；私聊不使用群配置。

固定来源与当前消息中的临时链接会规范化合并并去重，合并后仍以 5 个链接为上限。超过上限时本轮不会调用模型，用户需要减少当前链接或先解绑固定来源。服务只持久化链接，每次分析仍使用应用身份实时读取最新内容。

## 使用示例

```text
@竞品分析 分析这份文档并总结主要风险 https://tenant.feishu.cn/docx/...
@竞品分析 对比这份表格中各地区的收入 https://tenant.feishu.cn/sheets/...
@竞品分析 按地区汇总收入，并在这个 Base 的“经营看板”创建柱状图 https://tenant.feishu.cn/base/...
@竞品分析 将分析结论写入这份文档末尾 https://tenant.feishu.cn/docx/...
@竞品分析 对比以下两组数据：A 组 120，B 组 96
```

写入请求出现确认卡后，点击“确认执行”或“取消”。兼容旧流程时，也可以由发起人在同一聊天发送 `确认`。

## 日志与排查

服务向标准输出写入 JSON 行日志，包括：

- 收到和发送的消息。
- 数据来源、读取范围、截断状态和返回字符数。
- Agent 工具的开始、完成和失败状态。
- 流式卡片更新失败及文本回退。

日志不会记录模型 API Key，但可能包含用户消息正文。生产环境应限制日志访问并配置适当的保留周期。

常用检查：

```bash
lark-cli whoami
npm test
npm run check
npm run build
curl http://127.0.0.1:8787/healthz
```
