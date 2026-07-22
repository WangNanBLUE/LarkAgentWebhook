import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import type { AppConfig } from "../config.js";
import type { ComponentProposal, ComponentType, MessageEvent, PendingAction } from "../types.js";
import { StateStore } from "../state/store.js";
import { BaseTools } from "../lark/base-tools.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { TOOL_DEFINITIONS } from "./tool-schemas.js";

interface RunContext {
  event: MessageEvent;
  prompt: string;
  conversationKey: string;
}

export class AgentRunner {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig, private readonly tools: BaseTools, private readonly state: StateStore) {
    this.client = new OpenAI({ baseURL: config.openai.baseURL, apiKey: config.openai.apiKey });
  }

  async run(context: RunContext): Promise<string> {
    const input: Responses.ResponseInput = [{ role: "user", content: context.prompt }];
    const deadline = Date.now() + this.config.agent.timeoutMs;

    for (let round = 0; round < this.config.agent.maxToolRounds; round += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Agent request timed out");
      const response = await this.client.responses.create({
        model: this.config.openai.model,
        instructions: AGENT_INSTRUCTIONS,
        input,
        tools: TOOL_DEFINITIONS,
        store: false,
      }, { signal: AbortSignal.timeout(remaining) });

      const calls = response.output.filter((item): item is Responses.ResponseFunctionToolCall => item.type === "function_call");
      if (calls.length === 0) return response.output_text || "未生成有效回答。";

      input.push(...response.output);
      for (const call of calls) {
        try {
          const result = await this.executeTool(call.name, JSON.parse(call.arguments) as Record<string, unknown>, context);
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        } catch (error) {
          input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) });
        }
      }
    }
    throw new Error("Agent tool limit exceeded");
  }

  private async executeTool(name: string, args: Record<string, unknown>, context: RunContext): Promise<unknown> {
    switch (name) {
      case "get_source_schema": return this.tools.getSourceSchema();
      case "resolve_snapshot_date": return this.tools.resolveSnapshotDate(args.requested_date as string | null);
      case "aggregate_books": return this.tools.dataQuery(JSON.parse(String(args.dsl_json)), String(args.snapshot_date));
      case "query_books": return this.tools.searchRecords({
        keyword: String(args.keyword), searchFields: args.search_fields as string[], selectFields: args.select_fields as string[], limit: Number(args.limit), snapshotDate: String(args.snapshot_date),
      });
      case "list_managed_components": return this.tools.listManagedComponents();
      case "get_managed_component": return this.tools.getManagedComponent(String(args.block_id));
      case "propose_component_create": {
        const proposal = this.tools.validateProposal({
          action: "create", name: String(args.name), type: String(args.component_type) as ComponentType,
          dataConfig: addDashboardDateFilter(JSON.parse(String(args.data_config_json)) as Record<string, unknown>, this.config.lark.snapshotField, String(args.snapshot_date)),
        });
        return this.saveProposal(proposal, context);
      }
      case "propose_component_update": {
        const proposal = this.tools.validateProposal({
          action: "update", blockId: String(args.block_id),
          name: args.name === null ? undefined : String(args.name),
          dataConfig: args.data_config_json === null ? undefined : addDashboardDateFilter(JSON.parse(String(args.data_config_json)) as Record<string, unknown>, this.config.lark.snapshotField, String(args.snapshot_date)),
        });
        return this.saveProposal(proposal, context);
      }
      default: throw new Error(`Unsupported tool: ${name}`);
    }
  }

  private saveProposal(proposal: ComponentProposal, context: RunContext): unknown {
    const action: PendingAction = {
      id: `pa_${randomUUID()}`,
      requesterId: context.event.sender_id,
      chatId: context.event.chat_id,
      rootMessageId: context.event.root_id ?? context.event.message_id,
      threadId: context.conversationKey,
      expiresAt: Date.now() + 10 * 60_000,
      kind: proposal.action === "create" ? "component.create" : "component.update",
      payload: proposal,
    };
    this.state.createPendingAction(action);
    return { ok: true, proposal_id: action.id, expires_in_minutes: 10, proposal, confirmation: "请在同一话题中 @竞品分析 回复：确认" };
  }
}

function addDashboardDateFilter(config: Record<string, unknown>, snapshotField: string, snapshotDate: string): Record<string, unknown> {
  if ("text" in config) return config;
  const timestamp = new Date(`${snapshotDate}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(timestamp)) throw new Error("snapshot_date must use YYYY-MM-DD");
  const existing = config.filter && typeof config.filter === "object" ? config.filter as Record<string, unknown> : {};
  const conditions = Array.isArray(existing.conditions) ? existing.conditions : [];
  return {
    ...config,
    filter: {
      conjunction: "and",
      conditions: [...conditions, { field_name: snapshotField, operator: "is", value: ["ExactDate", String(timestamp)] }],
    },
  };
}
