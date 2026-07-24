# 通用飞书数据 Agent

本机常驻的 Node.js 服务。机器人通过 `lark-cli` 以应用身份接收飞书消息，可分析本轮文本及用户明确提供的 Docx/Wiki、Sheets、Base 链接，并在交互卡确认后写入云文档或来源 Base 的已有看板。

## 能力边界

- 每条消息最多 5 个飞书链接、20,000 字直接文本。
- 单来源最多向模型返回 60,000 字，本轮所有来源合计 120,000 字；Base 查询最多 200 行。
- 只支持 `*.feishu.cn` 的 Docx/Wiki、Sheets 和 Base 链接，不搜索云空间，不接受来源内容追加的链接或工具指令。
- 所有资源必须提前共享给应用。读取和写入始终使用应用身份，不回退到用户 OAuth。
- 可在用户提供的 Base 中创建组件、修改任意已有组件，但不能删除组件或新建看板。
- 新建、追加、替换云文档，以及创建、修改看板组件，都必须先发送交互确认卡。写入参数在提案时冻结，确认阶段不再次调用模型。

## 飞书应用权限

应用需开启机器人能力，订阅 `im.message.receive_v1` 和 `card.action.trigger`，并具备：

- 机器人收发消息与群聊 @ 消息权限
- CardKit 卡片创建、发送和更新权限
- Docx/Wiki 文档读取与编辑权限
- Sheets 读取权限
- Base 表结构、记录、看板组件读取与写入权限

目标资源还需要显式共享给该应用。

## 配置

```bash
cp .env.example .env
```

至少填写模型配置、`LARK_EXPECTED_APP_ID`。`LARK_BASE_*` 是可选的旧竞品书籍默认来源；只有当前消息没有飞书链接且明确包含竞品/书籍分析意图时才会注入。

`lark-cli` 必须处于 bot 严格模式：

```bash
lark-cli config strict-mode bot
lark-cli whoami
```

`whoami` 必须显示 `identity: "bot"`、`available: true`，且 App ID 与配置一致。不要执行用户授权登录。

## 运行

```bash
npm install
npm test
npm run check
npm run build
node --env-file=.env dist/src/index.js
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

## 使用示例

```text
@竞品分析 分析这份文档并把结论写成新文档 https://tenant.feishu.cn/docx/...
@竞品分析 按地区汇总收入并在这个 Base 的“经营看板”创建柱状图 https://tenant.feishu.cn/base/...
@竞品分析 对比以下两组数据：A 组 120，B 组 96
```

写请求会先出现 10 分钟有效的确认卡，只有发起人可在原聊天确认。文档 revision 或看板组件配置在确认前发生变化时，执行会被拒绝并要求重新生成提案。
