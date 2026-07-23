export interface DashboardTarget {
  sourceId: string;
  baseToken: string;
  dashboardId: string;
}

export interface FrozenComponent {
  name: string;
  type: ComponentType;
  dataConfig: Record<string, unknown>;
}

export type FrozenAction =
  | { kind: "dashboard.component.create"; target: DashboardTarget; component: FrozenComponent; idempotencyKey: string }
  | { kind: "dashboard.component.update"; target: DashboardTarget & { blockId: string }; before: FrozenComponent; after: FrozenComponent; configHash: string }
  | { kind: "document.create"; title: string; contentXml: string; idempotencyKey: string }
  | { kind: "document.append"; document: string; contentXml: string; revisionId: number; idempotencyKey: string }
  | { kind: "document.replace"; document: string; blockId: string; oldContentHash: string; contentXml: string; revisionId: number; idempotencyKey: string };

export type FrozenActionKind = FrozenAction["kind"];
import type { ComponentType } from "../types.js";
