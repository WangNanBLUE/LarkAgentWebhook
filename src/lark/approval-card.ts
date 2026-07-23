import type { ComponentProposal, PendingAction } from "../types.js";

export type ApprovalCardStatus = "pending" | "executing" | "completed" | "cancelled" | "unknown";

const STATUS = {
  pending: { template: "yellow", label: "等待确认", title: "看板变更待确认" },
  executing: { template: "blue", label: "执行中", title: "正在执行看板变更" },
  completed: { template: "green", label: "已完成", title: "看板变更已完成" },
  cancelled: { template: "grey", label: "已取消", title: "看板变更已取消" },
  unknown: { template: "red", label: "结果未知", title: "看板变更结果未知" },
} as const;

export function buildApprovalCard(action: PendingAction, status: ApprovalCardStatus, detail?: string): Record<string, unknown> {
  const proposal = action.payload as ComponentProposal;
  const meta = STATUS[status];
  const operation = proposal.action === "create" ? "新增组件" : "修改组件";
  const target = proposal.action === "create" ? proposal.name : proposal.name ?? proposal.blockId;
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
          content: detail ? escapeMarkdown(detail).slice(0, 500) : status === "pending" ? "确认后将写入竞品书籍 AI 分析看板，10 分钟内有效。" : `状态：${meta.label}`,
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
        confirm: { title: { tag: "plain_text", content: "确认执行" }, text: { tag: "plain_text", content: "该操作将修改飞书多维表格看板。" } },
      }] },
      { tag: "column", width: "weighted", weight: 1, elements: [{
        tag: "button", text: { tag: "plain_text", content: "取消" }, type: "default", width: "fill",
        behaviors: [{ type: "callback", value: { action: "cancel", proposal_id: proposalId } }],
      }] },
    ],
  };
}

function buildSummary(proposal: ComponentProposal): string {
  if (proposal.action === "create") return `类型：${escapeMarkdown(proposal.type)}\n数据配置：${escapeMarkdown(JSON.stringify(proposal.dataConfig)).slice(0, 800)}`;
  return `组件 ID：${escapeMarkdown(proposal.blockId)}\n变更：${escapeMarkdown(JSON.stringify({ name: proposal.name, dataConfig: proposal.dataConfig })).slice(0, 800)}`;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("&", "&#38;").replaceAll("<", "&#60;").replaceAll(">", "&#62;")
    .replace(/[\*~\[\]()#:_]/g, (character) => `&#${character.charCodeAt(0)};`);
}
