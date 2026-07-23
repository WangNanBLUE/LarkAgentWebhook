import { describe, expect, test } from "vitest";
import { SourceBudget } from "../src/sources/budget.js";
import { SourceRegistry } from "../src/sources/registry.js";

function ids(...values: string[]): () => string {
  const iterator = values[Symbol.iterator]();
  return () => {
    const value = iterator.next().value;
    if (!value) throw new Error("Test source ID sequence exhausted");
    return value;
  };
}

describe("source registry", () => {
  test("registers text and supported Feishu links with opaque ids", () => {
    const registry = SourceRegistry.fromPrompt(
      "分析这段数据：收入 12，成本 8 https://acme.feishu.cn/base/bascn1?table=tbl1",
      { idFactory: ids("src_text", "src_base") },
    );

    expect(registry.list()).toEqual([
      { id: "src_text", kind: "text", title: "消息文本" },
      { id: "src_base", kind: "base", title: "bascn1" },
    ]);
    expect(registry.require("src_base").url).toContain("/base/");
  });

  test.each([
    "http://acme.feishu.cn/docx/a",
    "https://feishu.cn.evil.test/docx/a",
    "https://acme.feishu.cn/slides/a",
  ])("rejects unsupported source %s", (url) => {
    expect(() => SourceRegistry.fromPrompt(url)).toThrow();
  });

  test("supports document, wiki and both sheet path variants", () => {
    const registry = SourceRegistry.fromPrompt([
      "https://a.feishu.cn/docx/doc1",
      "https://a.feishu.cn/wiki/wiki1",
      "https://a.feishu.cn/sheets/sheet1",
      "https://a.feishu.cn/spreadsheets/sheet2",
    ].join(" "), { idFactory: ids("src_doc", "src_wiki", "src_sheet_1", "src_sheet_2") });

    expect(registry.list().map(({ kind }) => kind)).toEqual(["document", "wiki", "sheet", "sheet"]);
  });

  test("rejects more than five links and cross-request source ids", () => {
    const urls = Array.from({ length: 6 }, (_, index) => `https://a.feishu.cn/docx/d${index}`).join(" ");
    expect(() => SourceRegistry.fromPrompt(urls)).toThrow("At most 5");
    expect(() => SourceRegistry.fromPrompt("纯文本").require("src_from_other_request")).toThrow("Unknown source");
  });

  test("rejects text sources over the configured limit", () => {
    expect(() => SourceRegistry.fromPrompt("x".repeat(20_001))).toThrow("20000");
  });

  test("enforces per-source and per-request output budgets", () => {
    const budget = new SourceBudget(10, 15);

    expect(budget.take("src_1", "123456789012")).toEqual({ text: "1234567890", truncated: true });
    expect(budget.take("src_2", "abcdefghij")).toEqual({ text: "abcde", truncated: true });
    expect(budget.take("src_1", "more")).toEqual({ text: "", truncated: true });
  });
});
