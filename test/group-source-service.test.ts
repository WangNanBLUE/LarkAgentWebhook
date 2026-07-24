import { afterEach, describe, expect, test, vi } from "vitest";
import { GroupSourceService } from "../src/service/group-source-service.js";
import { StateStore } from "../src/state/store.js";
import type { MessageEvent } from "../src/types.js";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function service(): GroupSourceService {
  const store = new StateStore(":memory:");
  stores.push(store);
  return new GroupSourceService(store);
}

const groupEvent: MessageEvent = {
  message_id: "om_1",
  chat_id: "oc_1",
  sender_id: "ou_1",
  chat_type: "group",
  content: "",
};

describe("group source commands", () => {
  test("binds, lists, removes, and clears supported group sources", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const commands = service();

    expect(commands.handle(
      groupEvent,
      "固定来源 https://tenant.feishu.cn/docx/a https://tenant.feishu.cn/base/b",
    )).toMatchObject({ handled: true, message: expect.stringContaining("已固定 2 个") });
    const listed = commands.handle(groupEvent, "查看固定来源");
    expect(listed).toMatchObject({ handled: true, message: expect.stringContaining("[document]") });
    expect(listed).toMatchObject({ handled: true, message: expect.stringContaining("/docx/a") });
    expect(listed).toMatchObject({ handled: true, message: expect.stringContaining("[base]") });
    expect(listed).toMatchObject({ handled: true, message: expect.stringContaining("/base/b") });
    expect(commands.handle(groupEvent, "解绑来源 https://tenant.feishu.cn/docx/a")).toMatchObject({
      handled: true,
      message: expect.stringContaining("已解绑 1 个"),
    });
    expect(commands.handle(groupEvent, "清空固定来源")).toMatchObject({
      handled: true,
      message: expect.stringContaining("已清空 1 个"),
    });
    expect(commands.handle(groupEvent, "查看固定来源")).toEqual({
      handled: true,
      message: "本群暂未固定分析来源。",
    });
  });

  test("keeps duplicate binding idempotent and reports missing removals", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const commands = service();
    commands.handle(groupEvent, "固定来源 https://tenant.feishu.cn/docx/a");

    expect(commands.handle(groupEvent, "固定来源 https://tenant.feishu.cn/docx/a")).toMatchObject({
      handled: true,
      message: expect.stringContaining("已存在 1 个"),
    });
    expect(commands.handle(groupEvent, "解绑来源 https://tenant.feishu.cn/docx/missing")).toMatchObject({
      handled: true,
      message: expect.stringContaining("未找到 1 个"),
    });
  });

  test("rejects malformed, unsupported, private, and over-limit commands without throwing", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const commands = service();

    expect(commands.handle(groupEvent, "固定来源")).toMatchObject({
      handled: true,
      message: expect.stringContaining("用法"),
    });
    expect(commands.handle(groupEvent, "固定来源 https://example.com/docx/a")).toMatchObject({
      handled: true,
      message: expect.stringContaining("不支持"),
    });
    expect(commands.handle({ ...groupEvent, chat_type: "p2p" }, "查看固定来源")).toMatchObject({
      handled: true,
      message: expect.stringContaining("仅支持群聊"),
    });
    expect(commands.handle(groupEvent, `固定来源 ${Array.from(
      { length: 6 },
      (_, index) => `https://tenant.feishu.cn/docx/${index}`,
    ).join(" ")}`)).toMatchObject({
      handled: true,
      message: expect.stringContaining("最多固定 5 个"),
    });
  });

  test("does not interpret ordinary analysis as a configuration command", () => {
    const commands = service();
    expect(commands.handle(groupEvent, "分析固定来源的收入趋势")).toEqual({ handled: false });
    expect(commands.handle(groupEvent, "固定来源分析")).toEqual({ handled: false });
  });
});
