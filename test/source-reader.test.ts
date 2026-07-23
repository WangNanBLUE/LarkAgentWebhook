import { describe, expect, test, vi } from "vitest";
import { BaseResource } from "../src/lark/base-resource.js";
import { LarkCliError } from "../src/lark/errors.js";
import { SourceReader } from "../src/lark/source-reader.js";
import { SourceBudget } from "../src/sources/budget.js";
import { SourceRegistry } from "../src/sources/registry.js";

function linkedSources() {
  const ids = ["src_doc", "src_sheet"][Symbol.iterator]();
  return SourceRegistry.fromPrompt(
    "https://a.feishu.cn/docx/doc_1 https://a.feishu.cn/sheets/sht_1",
    { idFactory: () => ids.next().value! },
  );
}

describe("Lark source reader", () => {
  test("reads document keyword matches and sheet ranges as bot", async () => {
    const cli = {
      runRetryable: vi.fn()
        .mockResolvedValueOnce({ document: { content: "<fragment><p>收入 12</p></fragment>" } })
        .mockResolvedValueOnce({ sheets: [{ sheet_id: "s1", title: "数据", row_count: 20, column_count: 2 }] })
        .mockResolvedValueOnce({ annotated_csv: "月份,收入\n7月,12" }),
    };
    const registry = linkedSources();
    const reader = new SourceReader(cli as never);
    const budget = new SourceBudget();

    const document = await reader.readDocument(
      registry.require("src_doc"),
      { mode: "keyword", keyword: "收入" },
      budget,
    );
    const workbook = await reader.inspectSheet(registry.require("src_sheet"));
    const sheet = await reader.readSheet(
      registry.require("src_sheet"),
      { sheet_id: "s1", range: "A1:B20" },
      budget,
    );

    expect(document).toMatchObject({
      source_id: "src_doc",
      source_type: "document",
      range: "keyword:收入",
      complete: false,
      content: "<fragment><p>收入 12</p></fragment>",
    });
    expect(workbook.content).toEqual({
      sheets: [{ sheet_id: "s1", title: "数据", row_count: 20, column_count: 2 }],
    });
    expect(sheet.content).toBe("月份,收入\n7月,12");
    expect(cli.runRetryable).toHaveBeenNthCalledWith(1, [
      "docs", "+fetch",
      "--doc", "https://a.feishu.cn/docx/doc_1",
      "--scope", "keyword",
      "--keyword", "收入",
      "--detail", "simple",
      "--as", "bot",
      "--format", "json",
    ]);
    expect(cli.runRetryable).toHaveBeenNthCalledWith(2, [
      "sheets", "+workbook-info",
      "--url", "https://a.feishu.cn/sheets/sht_1",
      "--as", "bot",
      "--format", "json",
    ]);
    expect(cli.runRetryable).toHaveBeenNthCalledWith(3, [
      "sheets", "+csv-get",
      "--url", "https://a.feishu.cn/sheets/sht_1",
      "--sheet-id", "s1",
      "--range", "A1:B20",
      "--as", "bot",
      "--format", "json",
    ]);
  });

  test("inspects document outline and validates range arguments", async () => {
    const cli = {
      runRetryable: vi.fn(async () => ({ document: { content: "<outline><h1 id=\"h1\">总览</h1></outline>" } })),
    };
    const source = linkedSources().require("src_doc");
    const reader = new SourceReader(cli as never);

    await expect(reader.inspectDocument(source, new SourceBudget())).resolves.toMatchObject({
      range: "outline",
      complete: false,
    });
    await expect(reader.readDocument(source, { mode: "keyword" } as never, new SourceBudget())).rejects.toThrow("keyword");
    expect(cli.runRetryable).toHaveBeenCalledTimes(1);
  });

  test("applies the shared source budget to returned content", async () => {
    const cli = { runRetryable: vi.fn(async () => ({ annotated_csv: "1234567890" })) };
    const result = await new SourceReader(cli as never).readSheet(
      linkedSources().require("src_sheet"),
      { sheet_id: "s1", range: "A1:A10" },
      new SourceBudget(4, 4),
    );

    expect(result).toMatchObject({ content: "1234", truncated: true, complete: false });
  });

  test("logs only source-read metadata, never fetched content", async () => {
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const cli = { runRetryable: vi.fn(async () => ({ annotated_csv: "机密收入,987654" })) };
      await new SourceReader(cli as never).readSheet(
        linkedSources().require("src_sheet"),
        { sheet_id: "s1", range: "A1:B2" },
        new SourceBudget(),
      );
    } finally {
      stdout.mockRestore();
    }
    const log = writes.join("");
    expect(log).toContain('"type":"source.read"');
    expect(log).toContain('"returned_characters":11');
    expect(log).not.toContain("机密收入");
    expect(log).not.toContain("987654");
  });

  test("resolves a Wiki sheet after a document type mismatch", async () => {
    const cli = {
      runRetryable: vi.fn()
        .mockRejectedValueOnce(new LarkCliError({ type: "api", subtype: "resource_type_mismatch" }))
        .mockResolvedValueOnce({ sheets: [{ sheet_id: "s1", title: "数据" }] }),
    };
    const source = SourceRegistry.fromPrompt(
      "https://a.feishu.cn/wiki/wiki_1",
      { idFactory: () => "src_wiki" },
    ).require("src_wiki");

    await expect(new SourceReader(cli as never).resolveWiki(source, new SourceBudget())).resolves.toMatchObject({
      source_type: "sheet",
      range: "workbook",
    });
    expect(cli.runRetryable).toHaveBeenCalledTimes(2);
  });

  test("does not probe another identity or resource type after a permission error", async () => {
    const cli = {
      runRetryable: vi.fn()
        .mockRejectedValueOnce(new LarkCliError({ type: "authorization", code: 91403, message: "forbidden" })),
    };
    const source = SourceRegistry.fromPrompt(
      "https://a.feishu.cn/wiki/wiki_1",
      { idFactory: () => "src_wiki" },
    ).require("src_wiki");

    await expect(new SourceReader(cli as never).resolveWiki(source, new SourceBudget())).rejects.toThrow("forbidden");
    expect(cli.runRetryable).toHaveBeenCalledTimes(1);
  });
});

describe("Base resource reader", () => {
  test("resolves and queries the Base provided in this request", async () => {
    const cli = {
      runRetryable: vi.fn()
        .mockResolvedValueOnce({ base_token: "bas_1", table_id: "tbl_1" })
        .mockResolvedValueOnce({ fields: [{ field_name: "地区" }, { field_name: "收入" }] })
        .mockResolvedValueOnce({ rows: [{ region: "华东", revenue: 12 }], has_more: false }),
    };
    const source = SourceRegistry.fromPrompt(
      "https://a.feishu.cn/base/bas_1?table=tbl_1",
      { idFactory: () => "src_base" },
    ).require("src_base");
    const resource = new BaseResource(cli as never);
    const location = await resource.resolve(source);
    await resource.fields(location, "tbl_1");
    const result = await resource.query(location, source, {
      table_id: "tbl_1",
      dimensions: [{ field_name: "地区", alias: "region" }],
      measures: [{ field_name: "收入", aggregation: "sum", alias: "revenue" }],
      filters: [],
      filter_conjunction: "and",
      sort: [],
      limit: 20,
    }, new SourceBudget());

    expect(location).toEqual({ sourceId: "src_base", baseToken: "bas_1", tableId: "tbl_1" });
    expect(result).toMatchObject({
      source_id: "src_base",
      source_type: "base",
      range: "table:tbl_1",
      complete: true,
    });
    expect(cli.runRetryable).toHaveBeenNthCalledWith(1, [
      "base", "+url-resolve",
      "--url", "https://a.feishu.cn/base/bas_1?table=tbl_1",
      "--as", "bot",
      "--format", "json",
    ]);
    const queryArgs = cli.runRetryable.mock.calls[2]?.[0] as string[];
    expect(queryArgs.slice(0, 4)).toEqual(["base", "+data-query", "--base-token", "bas_1"]);
    expect(queryArgs).toContain("--dsl");
    expect(JSON.parse(queryArgs[queryArgs.indexOf("--dsl") + 1] ?? "{}")).toMatchObject({
      datasource: { type: "table", table: { tableId: "tbl_1" } },
      pagination: { limit: 20 },
      shaper: { format: "flat" },
    });
    expect(queryArgs).toContain("bot");
  });

  test("requires field inspection before querying a table", async () => {
    const cli = {
      runRetryable: vi.fn(async () => ({ base_token: "bas_1", table_id: "tbl_1" })),
    };
    const source = SourceRegistry.fromPrompt(
      "https://a.feishu.cn/base/bas_1?table=tbl_1",
      { idFactory: () => "src_base" },
    ).require("src_base");
    const resource = new BaseResource(cli as never);
    const location = await resource.resolve(source);

    await expect(resource.query(location, source, {
      table_id: "tbl_1",
      dimensions: [],
      measures: [{ field_name: "收入", aggregation: "sum", alias: "revenue" }],
      filters: [],
      filter_conjunction: "and",
      sort: [],
      limit: 20,
    }, new SourceBudget())).rejects.toThrow("fields");
    expect(cli.runRetryable).toHaveBeenCalledTimes(1);
  });
});
