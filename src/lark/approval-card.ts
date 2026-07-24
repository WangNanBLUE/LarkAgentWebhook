import type { FrozenAction } from "../actions/types.js";
import type { PendingAction } from "../types.js";

export type ApprovalCardStatus = "pending" | "executing" | "completed" | "cancelled" | "failed" | "unknown";

const STATUS = {
  pending: { template: "yellow", label: "等待确认", title: "看板变更待确认" },
  executing: { template: "blue", label: "执行中", title: "正在执行看板变更" },
  completed: { template: "green", label: "已完成", title: "看板变更已完成" },
  cancelled: { template: "grey", label: "已取消", title: "看板变更已取消" },
  failed: { template: "red", label: "未执行", title: "变更未执行" },
  unknown: { template: "red", label: "结果未知", title: "看板变更结果未知" },
} as const;

export function buildApprovalCard(action: PendingAction, status: ApprovalCardStatus, detail?: string): Record<string, unknown> {
  const proposal = action.payload;
  const meta = STATUS[status];
  const operation = operationLabel(proposal);
  const target = targetLabel(proposal);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "column_set", flex_mode: "none", margin: "0px 0px 12px 0px",
      columns: [{
        tag: "column", width: "weighted", weight: 1, background_style: `${meta.template}-50`,
        padding: "12px", vertical_spacing: "4px", elements: [
          { tag: "markdown", content: `<at id=${action.requesterId}></at> **${operation}：${escapeMarkdown(target)}**` },
          { tag: "markdown", content: buildSummary(proposal), text_size: "notation" },
        ],
      }],
    },
    {
      tag: "column_set", flex_mode: "none", margin: "0px",
      columns: [{
        tag: "column", width: "weighted", weight: 1, background_style: "grey-50",
        padding: "12px", elements: [{
          tag: "markdown",
          content: detail ? escapeMarkdown(detail).slice(0, 500) : status === "pending" ? "确认后将以应用身份写入上述飞书资源，10 分钟内有效。" : `状态：${meta.label}`,
        }],
      }],
    },
  ];
  if (status === "pending") elements.push(buildButtons(action.id));
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default", summary: { content: meta.title } },
    header: {
      title: { tag: "plain_text", content: meta.title },
      subtitle: { tag: "plain_text", content: `提案 ${action.id}` },
      template: meta.template,
      icon: { tag: "standard_icon", token: "approve_colorful" },
      text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: meta.label }, color: meta.template }],
    },
    body: { direction: "vertical", padding: "12px 12px 20px 12px", elements },
  };
}

function buildButtons(proposalId: string): Record<string, unknown> {
  return {
    tag: "column_set", flex_mode: "bisect", horizontal_spacing: "12px", margin: "12px 0px 0px 0px",
    columns: [
      { tag: "column", width: "weighted", weight: 1, elements: [{
        tag: "button", text: { tag: "plain_text", content: "确认执行" }, type: "primary_filled", width: "fill",
        behaviors: [{ type: "callback", value: { action: "confirm", proposal_id: proposalId } }],
        confirm: { title: { tag: "plain_text", content: "确认执行" }, text: { tag: "plain_text", content: "该操作将修改飞书资源。" } },
      }] },
      { tag: "column", width: "weighted", weight: 1, elements: [{
        tag: "button", text: { tag: "plain_text", content: "取消" }, type: "default", width: "fill",
        behaviors: [{ type: "callback", value: { action: "cancel", proposal_id: proposalId } }],
      }] },
    ],
  };
}

function operationLabel(action: FrozenAction): string {
  return {
    "dashboard.component.create": "新增看板组件",
    "dashboard.component.update": "修改看板组件",
    "document.create": "新建云文档",
    "document.append": "追加云文档",
    "document.replace": "替换文档内容块",
  }[action.kind];
}

function targetLabel(action: FrozenAction): string {
  if (action.kind === "dashboard.component.create") return action.component.name;
  if (action.kind === "dashboard.component.update") return action.after.name;
  if (action.kind === "document.create") return action.title;
  return action.document;
}

function buildSummary(action: FrozenAction): string {
  if (action.kind === "dashboard.component.create") {
    return `看板 ID：${escapeMarkdown(action.target.dashboardId)}\n类型：${escapeMarkdown(action.component.type)}\n配置：${escapeMarkdown(JSON.stringify(action.component.dataConfig)).slice(0, 700)}`;
  }
  if (action.kind === "dashboard.component.update") {
    return `组件 ID：${escapeMarkdown(action.target.blockId)}\n原配置：${escapeMarkdown(JSON.stringify(action.before)).slice(0, 350)}\n新配置：${escapeMarkdown(JSON.stringify(action.after)).slice(0, 350)}`;
  }
  if (action.kind === "document.create") return `标题：${escapeMarkdown(action.title)}\n内容长度：${action.contentXml.length} 字符`;
  if (action.kind === "document.append") return `目标：${escapeMarkdown(action.document)}\n追加长度：${action.contentXml.length} 字符`;
  return `目标：${escapeMarkdown(action.document)}\nBlock ID：${escapeMarkdown(action.blockId)}\n替换长度：${action.contentXml.length} 字符`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("&", "&#38;").replaceAll("<", "&#60;").replaceAll(">", "&#62;")
    .replace(/[\*~\[\]()#:_]/g, (character) => `&#${character.charCodeAt(0)};`);
}
