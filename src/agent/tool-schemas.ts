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
const dataConfig = { type: "object", additionalProperties: true };

export const TOOL_DEFINITIONS: Responses.FunctionTool[] = [
  {
    type: "function", name: "inspect_folder", description: "列出飞书云盘文件夹的直接子项，最多 200 个，不递归读取文件内容。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
    }, ["source_id"]),
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
    type: "function", name: "propose_dashboard_component_create", description: "为本轮 Base 中的已有看板准备组件创建提案。只生成确认卡，不立即写入。",
    strict: false, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      dashboard_id: { type: "string" },
      name: { type: "string" },
      component_type: { type: "string", enum: ["statistics", "column", "bar", "line", "pie", "ring", "area", "combo", "scatter", "funnel", "wordCloud", "radar", "text"] },
      data_config: dataConfig,
    }, ["source_id", "dashboard_id", "name", "component_type", "data_config"]),
  },
  {
    type: "function", name: "propose_dashboard_component_update", description: "为本轮 Base 中任意已有组件准备更新提案。只生成确认卡，不立即写入。",
    strict: false, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      dashboard_id: { type: "string" },
      block_id: { type: "string" },
      name: { type: ["string", "null"] },
      data_config_patch: { anyOf: [dataConfig, { type: "null" }] },
    }, ["source_id", "dashboard_id", "block_id", "name", "data_config_patch"]),
  },
  {
    type: "function", name: "propose_document_create", description: "准备新建飞书文档提案。只生成确认卡，不立即写入。",
    strict: true, parameters: object({
      title: { type: "string", minLength: 1, maxLength: 200 },
      content_xml: { type: "string", minLength: 1, maxLength: 100000 },
    }, ["title", "content_xml"]),
  },
  {
    type: "function", name: "propose_document_append", description: "准备向本轮 Docx/Wiki 文档末尾追加内容的提案。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      content_xml: { type: "string", minLength: 1, maxLength: 100000 },
    }, ["source_id", "content_xml"]),
  },
  {
    type: "function", name: "propose_document_replace", description: "准备替换本轮 Docx/Wiki 文档中一个明确 block 的提案。",
    strict: true, parameters: object({
      source_id: { type: "string", pattern: "^src_[A-Za-z0-9-]+$" },
      block_id: { type: "string" },
      content_xml: { type: "string", minLength: 1, maxLength: 100000 },
    }, ["source_id", "block_id", "content_xml"]),
  },
];
