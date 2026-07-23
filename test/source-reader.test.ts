import { describe, expect, test, vi } from "vitest";
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
