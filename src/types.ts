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

export interface PendingAction {
  id: string;
  requesterId: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  expiresAt: number;
  kind: "component.create" | "component.update";
  payload: unknown;
}

export type ComponentType = "statistics" | "column" | "line" | "pie" | "ring" | "text";

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
