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
    type: "function", name: "list_input_sources", description: "列出用户本轮明确提供、可供分析的文本或飞书资源。只返回 source_id、类型和标题。",
    strict: true, parameters: object({}, []),
  },
  {
    type: "function", name: "inspect_document", description: "读取 Docx/Wiki 文档目录。只接受本轮 source_id，不接受链接或 token。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
    }, ["source_id"]),
  },
  {
    type: "function", name: "read_document", description: "按关键词、章节、block 范围或整篇读取 Docx/Wiki。优先局部读取。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      mode: { type: "string", enum: ["keyword", "section", "range", "full"] },
      keyword: { type: ["string", "null"] },
      start_block_id: { type: ["string", "null"] },
      end_block_id: { type: ["string", "null"] },
    }, ["source_id", "mode", "keyword", "start_block_id", "end_block_id"]),
  },
  {
    type: "function", name: "inspect_sheet", description: "读取电子表格工作簿和真实子表结构。读取数据前先调用。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
    }, ["source_id"]),
  },
  {
    type: "function", name: "read_sheet", description: "按真实 sheet_id 和 A1 range 读取电子表格数据。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      sheet_id: { type: "string" },
      range: { type: "string" },
    }, ["source_id", "sheet_id", "range"]),
  },
  {
    type: "function", name: "inspect_base", description: "解析多维表格并读取目录、数据表和可选表字段。查询前必须读取目标表字段。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      table_id: { type: ["string", "null"] },
    }, ["source_id", "table_id"]),
  },
  {
    type: "function", name: "query_base", description: "对本轮 Base 来源做云端分组、聚合、筛选、排序和 Top N，不接受原始 DSL。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      table_id: { type: "string" },
      dimensions: { type: "array", items: dimension, maxItems: 5 },
      measures: { type: "array", items: measure, maxItems: 10 },
      filters: { type: "array", items: object({
        field_name: { type: "string" },
        operator: { type: "string", enum: ["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual"] },
        value: { anyOf: [
          { type: "string" }, { type: "number" }, { type: "boolean" },
          { type: "array", items: { type: "string" } }, { type: "null" },
        ] },
      }, ["field_name", "operator", "value"]), maxItems: 10 },
      filter_conjunction: { type: "string", enum: ["and", "or"] },
      sort: { type: "array", items: sort, maxItems: 5 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }, ["source_id", "table_id", "dimensions", "measures", "filters", "filter_conjunction", "sort", "limit"]),
  },
  {
    type: "function", name: "list_base_dashboards", description: "列出本轮 Base 来源中的真实看板和组件目录。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      dashboard_id: { type: ["string", "null"] },
    }, ["source_id", "dashboard_id"]),
  },
  {
    type: "function", name: "get_dashboard_component", description: "读取本轮 Base 来源中一个现有看板组件的完整配置。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      dashboard_id: { type: "string" },
      block_id: { type: "string" },
    }, ["source_id", "dashboard_id", "block_id"]),
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
  {
    type: "function", name: "create_document", description: "仅在用户明确要求时，以应用身份新建并由应用拥有竞品分析飞书文档。不搜索或读取其他文档。content_xml 使用合法 Docx XML，且不包含 title 标签。",
    strict: true, parameters: object({
      title: { type: "string", minLength: 1, maxLength: 200 },
      content_xml: { type: "string", minLength: 1, maxLength: 100000 },
    }, ["title", "content_xml"]),
  },
  {
    type: "function", name: "append_document", description: "仅在用户明确提供文档 URL/token、要求追加且该文档已向应用开放编辑权限时，以应用身份向文档末尾追加竞品分析内容。不读取、覆盖或删除原内容。",
    strict: true, parameters: object({
      document: { type: "string", minLength: 1, maxLength: 1000, description: "用户提供的飞书文档 URL 或 token" },
      content_xml: { type: "string", minLength: 1, maxLength: 100000 },
    }, ["document", "content_xml"]),
  },
];
