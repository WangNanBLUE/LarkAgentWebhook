import type { Responses } from "openai/resources/responses/responses";

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

const dimension = object({
  field_name: { type: "string", description: "真实字段名" },
  alias: { type: ["string", "null"], description: "唯一英文别名；不需要时为 null" },
}, ["field_name", "alias"]);
const measure = object({
  field_name: { type: "string", description: "真实字段名" },
  aggregation: { type: "string", enum: ["sum", "avg", "min", "max", "count", "count_all", "distinct_count"] },
  alias: { type: "string", description: "唯一英文别名" },
}, ["field_name", "aggregation", "alias"]);
const filter = object({
  field_name: { type: "string" },
  operator: { type: "string", enum: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual"] },
  value: { type: "array", items: { type: "string" }, description: "筛选值；空值操作符传空数组" },
}, ["field_name", "operator", "value"]);
const sort = object({
  field_name: { type: "string", description: "真实字段名或 measure alias" },
  order: { type: "string", enum: ["asc", "desc"] },
}, ["field_name", "order"]);
const chartMetric = object({
  kind: { type: "string", enum: ["count_all", "field"], description: "统计记录数用 count_all；聚合数值字段用 field" },
  field_name: { type: ["string", "null"], description: "kind=field 时为真实数值字段名，否则为 null" },
  rollup: { type: ["string", "null"], enum: ["SUM", "MAX", "MIN", "AVERAGE", null] },
}, ["kind", "field_name", "rollup"]);
const chartGroup = object({
  field_name: { type: "string", description: "真实分组字段名" },
  mode: { type: "string", enum: ["integrated", "enumerated"], description: "文本、单选、日期等单值字段用 integrated；多选、人员等多值字段用 enumerated" },
  sort_type: { type: ["string", "null"], enum: ["group", "value", "view", null] },
  sort_order: { type: ["string", "null"], enum: ["asc", "desc", null] },
}, ["field_name", "mode", "sort_type", "sort_order"]);
const chartFilter = object({
  field_name: { type: "string" },
  operator: { type: "string", enum: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual"] },
  value: { anyOf: [
    { type: "string" }, { type: "number" }, { type: "boolean" },
    { type: "array", items: { type: "string" } }, { type: "null" },
  ], description: "isEmpty/isNotEmpty 时为 null，其他操作符传真实字段值" },
}, ["field_name", "operator", "value"]);

export const TOOL_DEFINITIONS: Responses.FunctionTool[] = [
  {
    type: "function", name: "get_source_schema", description: "读取竞品书籍快照表的真实字段结构。任何数据查询前先调用。",
    strict: true, parameters: object({}, []),
  },
  {
    type: "function", name: "resolve_snapshot_date", description: "解析查询应使用的快照日期。未指定日期时返回最新快照。",
    strict: true, parameters: object({ requested_date: { type: ["string", "null"], description: "用户明确指定的日期，否则为 null" } }, ["requested_date"]),
  },
  {
    type: "function", name: "aggregate_books", description: "对书籍做分组、聚合、筛选、排序和 Top N。参数已结构化，不要生成 DSL JSON。dimensions 和 measures 至少一个非空。",
    strict: true, parameters: object({
      dimensions: { type: "array", items: dimension, maxItems: 5 },
      measures: { type: "array", items: measure, maxItems: 10 },
      filters: { type: "array", items: filter, maxItems: 10, description: "额外筛选条件；快照日期由服务自动添加" },
      filter_conjunction: { type: "string", enum: ["and", "or"] },
      sort: { type: "array", items: sort, maxItems: 5 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      snapshot_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "resolve_snapshot_date 返回的 YYYY-MM-DD" },
    }, ["dimensions", "measures", "filters", "filter_conjunction", "sort", "limit", "snapshot_date"]),
  },
  {
    type: "function", name: "query_books", description: "按关键词查询少量具体书籍明细，不用于全局统计。",
    strict: true, parameters: object({
      keyword: { type: "string" },
      search_fields: { type: "array", items: { type: "string" } },
      select_fields: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      snapshot_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    }, ["keyword", "search_fields", "select_fields", "limit", "snapshot_date"]),
  },
  {
    type: "function", name: "list_managed_components", description: "列出本服务在 AI 分析看板中登记的组件。",
    strict: true, parameters: object({}, []),
  },
  {
    type: "function", name: "get_managed_component", description: "读取一个由本服务管理的组件配置及计算结果。",
    strict: true, parameters: object({ block_id: { type: "string" } }, ["block_id"]),
  },
  {
    type: "function", name: "propose_chart_component_create", description: "用结构化参数生成图表组件预览并等待用户确认。不要构造 data_config JSON。",
    strict: true, parameters: object({
      name: { type: "string" },
      component_type: { type: "string", enum: ["statistics", "column", "line", "pie", "ring"] },
      metric: chartMetric,
      group_by: { type: "array", items: chartGroup, maxItems: 2, description: "statistics 传空数组；pie/ring 恰好一项；column/line 为 1-2 项" },
      filters: { type: "array", items: chartFilter, maxItems: 10, description: "额外筛选条件；快照日期由服务自动添加" },
      filter_conjunction: { type: "string", enum: ["and", "or"] },
      snapshot_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    }, ["name", "component_type", "metric", "group_by", "filters", "filter_conjunction", "snapshot_date"]),
  },
  {
    type: "function", name: "propose_text_component_create", description: "生成 Markdown 文本组件预览并等待用户确认。",
    strict: true, parameters: object({
      name: { type: "string" },
      text: { type: "string" },
    }, ["name", "text"]),
  },
  {
    type: "function", name: "propose_component_update", description: "生成修改服务托管组件的预览并等待用户确认，不立即写入。",
    strict: true, parameters: object({
      block_id: { type: "string" },
      name: { type: ["string", "null"] },
      data_config_json: { type: ["string", "null"] },
      snapshot_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    }, ["block_id", "name", "data_config_json", "snapshot_date"]),
  },
];
