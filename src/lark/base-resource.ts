import { z } from "zod";
import type { SourceBudget } from "../sources/budget.js";
import type { InputSource, SourceReadResult } from "../sources/types.js";
import { logSourceRead } from "../sources/read-log.js";
import type { LarkCli } from "./cli.js";

const dimensionSchema = z.object({
  field_name: z.string().min(1),
  alias: z.string().min(1).nullable(),
}).strict();
const measureSchema = z.object({
  field_name: z.string().min(1),
  aggregation: z.enum(["sum", "avg", "min", "max", "count", "count_all", "distinct_count"]),
  alias: z.string().min(1),
}).strict();
const filterSchema = z.object({
  field_name: z.string().min(1),
  operator: z.enum(["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
}).strict();
const querySchema = z.object({
  table_id: z.string().min(1),
  dimensions: z.array(dimensionSchema).max(5),
  measures: z.array(measureSchema).max(10),
  filters: z.array(filterSchema).max(10),
  filter_conjunction: z.enum(["and", "or"]),
  sort: z.array(z.object({
    field_name: z.string().min(1),
    order: z.enum(["asc", "desc"]),
  }).strict()).max(5),
  limit: z.number().int().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.dimensions.length === 0 && value.measures.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "dimensions and measures cannot both be empty" });
  }
  value.filters.forEach((filter, index) => {
    const emptyOperator = filter.operator === "isEmpty" || filter.operator === "isNotEmpty";
    if (emptyOperator && filter.value !== null && !(Array.isArray(filter.value) && filter.value.length === 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["filters", index, "value"], message: "empty operators require null or an empty array" });
    }
    if (!emptyOperator && (filter.value === undefined || filter.value === null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["filters", index, "value"], message: "filter requires value" });
    }
  });
});

export type StructuredBaseQuery = z.input<typeof querySchema>;

export interface BaseLocation {
  sourceId: string;
  baseToken: string;
  tableId?: string;
  viewId?: string;
}

export class BaseResource {
  private readonly locations = new Map<string, BaseLocation>();
  private readonly inspectedTables = new Set<string>();

  constructor(private readonly cli: LarkCli) {}

  async resolve(source: InputSource): Promise<BaseLocation> {
    if (source.kind !== "base" && source.kind !== "wiki") throw new Error(`Source ${source.id} is not a Base source`);
    const cached = this.locations.get(source.id);
    if (cached) return cached;
    if (source.resolvedBase) {
      const location = { sourceId: source.id, ...source.resolvedBase };
      this.locations.set(source.id, location);
      return location;
    }
    if (!source.url) throw new Error(`Source ${source.id} does not have a URL`);
    const data = await this.cli.runRetryable<unknown>([
      "base", "+url-resolve",
      "--url", source.url,
      "--as", "bot",
      "--format", "json",
    ]);
    const baseToken = findString(data, ["base_token", "baseToken", "app_token"]);
    if (!baseToken) throw new Error("Base URL resolution did not return a base token");
    const location: BaseLocation = {
      sourceId: source.id,
      baseToken,
      ...(findString(data, ["table_id", "tableId"]) ? { tableId: findString(data, ["table_id", "tableId"]) } : {}),
      ...(findString(data, ["view_id", "viewId"]) ? { viewId: findString(data, ["view_id", "viewId"]) } : {}),
    };
    this.locations.set(source.id, location);
    return location;
  }

  listBlocks(location: BaseLocation): Promise<unknown> {
    return this.cli.runRetryable([
      "base", "+base-block-list",
      "--base-token", location.baseToken,
      "--as", "bot",
      "--format", "json",
    ]);
  }

  listTables(location: BaseLocation): Promise<unknown> {
    return this.cli.runRetryable([
      "base", "+table-list",
      "--base-token", location.baseToken,
      "--as", "bot",
      "--format", "json",
    ]);
  }

  async fields(location: BaseLocation, tableId: string): Promise<unknown> {
    const data = await this.cli.runRetryable([
      "base", "+field-list",
      "--base-token", location.baseToken,
      "--table-id", tableId,
      "--as", "bot",
      "--format", "json",
    ]);
    this.inspectedTables.add(tableKey(location, tableId));
    return data;
  }

  async query(
    location: BaseLocation,
    source: InputSource,
    rawInput: StructuredBaseQuery,
    budget: SourceBudget,
  ): Promise<SourceReadResult> {
    const input = querySchema.parse(rawInput);
    if (!this.inspectedTables.has(tableKey(location, input.table_id))) {
      throw new Error("Base table fields must be inspected before querying");
    }
    const dsl = {
      datasource: { type: "table", table: { tableId: input.table_id } },
      ...(input.dimensions.length ? {
        dimensions: input.dimensions.map((item) => item.alias === null ? { field_name: item.field_name } : item),
      } : {}),
      ...(input.measures.length ? { measures: input.measures } : {}),
      ...(input.filters.length ? {
        filters: {
          type: 1,
          conjunction: input.filter_conjunction,
          conditions: input.filters.map((filter) => {
            const emptyOperator = filter.operator === "isEmpty" || filter.operator === "isNotEmpty";
            return emptyOperator ? { ...filter, value: [] } : filter;
          }),
        },
      } : {}),
      ...(input.sort.length ? { sort: input.sort } : {}),
      pagination: { limit: input.limit },
      shaper: { format: "flat" },
    };
    const data = await this.cli.runRetryable<unknown>([
      "base", "+data-query",
      "--base-token", location.baseToken,
      "--dsl", JSON.stringify(dsl),
      "--as", "bot",
      "--format", "json",
    ]);
    const serialized = JSON.stringify(data);
    const bounded = budget.take(source.id, serialized);
    const hasMore = findBoolean(data, ["has_more", "hasMore"]);
    const result: SourceReadResult = {
      source_id: source.id,
      source_type: "base",
      title: source.title,
      range: `table:${input.table_id}`,
      complete: !bounded.truncated && hasMore !== true,
      truncated: bounded.truncated,
      content: bounded.text,
    };
    logSourceRead(source, result);
    return result;
  }

  listDashboards(location: BaseLocation): Promise<unknown> {
    return this.cli.runRetryable([
      "base", "+dashboard-list",
      "--base-token", location.baseToken,
      "--as", "bot",
      "--format", "json",
    ]);
  }

  listDashboardBlocks(location: BaseLocation, dashboardId: string): Promise<unknown> {
    return this.cli.runRetryable([
      "base", "+dashboard-block-list",
      "--base-token", location.baseToken,
      "--dashboard-id", dashboardId,
      "--page-size", "100",
      "--as", "bot",
      "--format", "json",
    ]);
  }

  getDashboardBlock(location: BaseLocation, dashboardId: string, blockId: string): Promise<unknown> {
    return this.cli.runRetryable([
      "base", "+dashboard-block-get",
      "--base-token", location.baseToken,
      "--dashboard-id", dashboardId,
      "--block-id", blockId,
      "--as", "bot",
      "--format", "json",
    ]);
  }
}

function tableKey(location: BaseLocation, tableId: string): string {
  return `${location.baseToken}:${tableId}`;
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = findString(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findBoolean(value: unknown, keys: string[]): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (typeof record[key] === "boolean") return record[key];
  for (const child of Object.values(record)) {
    const found = findBoolean(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}
