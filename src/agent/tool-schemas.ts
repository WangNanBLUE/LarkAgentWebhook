import type { Responses } from "openai/resources/responses/responses";

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

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
    type: "function", name: "aggregate_books", description: "使用 Base data-query DSL 做筛选、分组、聚合、排序和 Top N。datasource、分页上限和输出格式由服务强制覆盖。",
    strict: true, parameters: object({
      dsl_json: { type: "string", description: "不含 datasource 和快照日期条件的合法 data-query JSON；alias 只能用英文" },
      snapshot_date: { type: "string", description: "resolve_snapshot_date 返回的 YYYY-MM-DD" },
    }, ["dsl_json", "snapshot_date"]),
  },
  {
    type: "function", name: "query_books", description: "按关键词查询少量具体书籍明细，不用于全局统计。",
    strict: true, parameters: object({
      keyword: { type: "string" },
      search_fields: { type: "array", items: { type: "string" } },
      select_fields: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      snapshot_date: { type: "string" },
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
    type: "function", name: "propose_component_create", description: "生成新增组件预览并等待用户确认，不立即写入。",
    strict: true, parameters: object({
      name: { type: "string" },
      component_type: { type: "string", enum: ["statistics", "column", "line", "pie", "ring", "text"] },
      data_config_json: { type: "string", description: "符合 lark-base dashboard data_config 规范的 JSON" },
      snapshot_date: { type: "string" },
    }, ["name", "component_type", "data_config_json", "snapshot_date"]),
  },
  {
    type: "function", name: "propose_component_update", description: "生成修改服务托管组件的预览并等待用户确认，不立即写入。",
    strict: true, parameters: object({
      block_id: { type: "string" },
      name: { type: ["string", "null"] },
      data_config_json: { type: ["string", "null"] },
      snapshot_date: { type: "string" },
    }, ["block_id", "name", "data_config_json", "snapshot_date"]),
  },
];
