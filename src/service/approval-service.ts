import { z } from "zod";
import { ActionExecutionError, type ActionExecutor } from "../actions/action-executor.js";
import { buildApprovalCard } from "../lark/approval-card.js";
import type { BaseTools } from "../lark/base-tools.js";
import type { StateStore } from "../state/store.js";
import type { CardActionEvent } from "../types.js";

const actionSchema = z.object({
  action: z.enum(["confirm", "cancel"]),
  proposal_id: z.string().startsWith("pa_"),
}).strict();

export class ApprovalService {
  constructor(
    private readonly state: StateStore,
    private readonly executor: ActionExecutor,
    private readonly tools: BaseTools,
  ) {}

  async handle(event: CardActionEvent): Promise<void> {
    if (event.action_tag !== "button" || !this.state.markMessageProcessed(event.event_id)) return;
    let input: z.infer<typeof actionSchema>;
    try { input = actionSchema.parse(JSON.parse(event.action_value)); }
    catch { return; }

    if (input.action === "cancel") {
      const cancelled = this.state.cancelPendingActionById(input.proposal_id, event.operator_id, event.chat_id);
      if (!cancelled.ok) return this.notifyUnavailable(event, cancelled.reason);
      await this.tools.updateInteractiveCard(event.token, buildApprovalCard(cancelled.action, "cancelled"));
      return;
    }

    const claimed = this.state.claimPendingActionById(input.proposal_id, event.operator_id, event.chat_id);
    if (!claimed.ok) return this.notifyUnavailable(event, claimed.reason);
    await this.tools.updateInteractiveCard(event.token, buildApprovalCard(claimed.action, "executing")).catch(() => undefined);
    try {
      const result = await this.executor.execute(claimed.action);
      this.state.markActionCompleted(claimed.action.id, result);
      await this.tools.updateInteractiveCard(event.token, buildApprovalCard(claimed.action, "completed", JSON.stringify(result))).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof ActionExecutionError ? error.outcome : "unknown";
      if (status === "failed") this.state.markActionFailed(claimed.action.id, message);
      else this.state.markActionUnknown(claimed.action.id, message);
      await this.tools.updateInteractiveCard(event.token, buildApprovalCard(claimed.action, status, message)).catch(() => undefined);
    }
  }

  private async notifyUnavailable(event: CardActionEvent, reason: "not_found" | "expired"): Promise<void> {
    const message = reason === "expired" ? "该变更预览已过期，请重新发起。" : "该变更不存在、已处理，或不是由你发起。";
    await this.tools.sendToChat(event.chat_id, `<at user_id="${event.operator_id}"></at> ${message}`);
  }
}
