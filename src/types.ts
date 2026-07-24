export interface Mention {
  id: string;
  key: string;
  name: string;
}

export interface MessageEvent {
  message_id: string;
  chat_id: string;
  sender_id: string;
  chat_type: "p2p" | "group";
  content: string;
  message_type?: string;
  root_id?: string;
  reply_to?: string;
  thread_id?: string;
  mentions?: Mention[];
}

export interface CardActionEvent {
  type: "card.action.trigger";
  event_id: string;
  operator_id: string;
  message_id: string;
  chat_id: string;
  token: string;
  action_tag: string;
  action_value: string;
}

export interface GroupSourceRecord {
  chatId: string;
  url: string;
  kind: "document" | "wiki" | "sheet" | "base";
  addedBy: string;
  createdAt: number;
}

import type { FrozenAction, FrozenActionKind } from "./actions/types.js";

export interface PendingAction {
  id: string;
  requesterId: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  expiresAt: number;
  kind: FrozenActionKind;
  payload: FrozenAction;
}

export type ComponentType =
  | "statistics" | "column" | "bar" | "line" | "pie" | "ring" | "area"
  | "combo" | "scatter" | "funnel" | "wordCloud" | "radar" | "text";

export type ComponentProposal = {
  action: "create";
  name: string;
  type: ComponentType;
  dataConfig: Record<string, unknown>;
} | {
  action: "update";
  blockId: string;
  name?: string;
  dataConfig?: Record<string, unknown>;
};
