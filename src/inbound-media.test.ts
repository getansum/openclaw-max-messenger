import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./media-access.js", () => ({ fetchRemoteMedia: stubs.fetch }));
import { collectInboundMedia } from "./inbound-media.js";
let home: string;
const message = { channel: "max", accountId: "default", chatId: "100", userId: "sender", messageId: "mid", text: "caption", timestamp: 0 };

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "max-inbound-test-"));
  vi.stubEnv("HOME", home);
  stubs.fetch.mockReset().mockResolvedValue({ buffer: Buffer.from("%PDF-1.7 fixture"), contentType: "application/octet-stream" });
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });

describe("inbound media acquisition", () => {
  it("saves a captioned PDF with Cyrillic name, canonical path and detected MIME", async () => {
    const result = await collectInboundMedia({ ...message, attachments: [{ type: "file", filename: "План кухни.pdf", url: "https://files.example/opaque" }] }, "default");
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toContain("План кухни.pdf");
    expect(result.types).toEqual(["application/pdf"]);
    expect(await fs.readFile(result.paths[0], "utf8")).toBe("%PDF-1.7 fixture");
    expect(stubs.fetch).toHaveBeenCalledWith("https://files.example/opaque", { maxBytes: 25 * 1024 * 1024 });
  });
  it("retains multiple files even when their names and timestamps are the same", async () => {
    const attachment = { type: "file" as const, filename: "file.pdf", url: "https://files.example/file" };
    const result = await collectInboundMedia({ ...message, attachments: [attachment, attachment] }, "default");
    expect(new Set(result.paths).size).toBe(2);
  });
  it("reports a token-only attachment instead of silently losing it", async () => {
    const result = await collectInboundMedia({ ...message, attachments: [{ type: "file", token: "fixture", filename: "document.pdf" }] }, "default");
    expect(result.descriptions[0]).toContain("отсутствует HTTP-ссылка");
    expect(result.paths).toEqual([]);
    expect(stubs.fetch).not.toHaveBeenCalled();
  });
  it("does not download a link preview as if it were a PDF", async () => {
    const result = await collectInboundMedia({ ...message, attachments: [{ type: "share", url: "https://acrobat.example/view" }] }, "default");
    expect(result.descriptions[0]).toContain("не скачанный файл");
    expect(stubs.fetch).not.toHaveBeenCalled();
  });
  it("rejects declared oversize before downloading and reports a failed download", async () => {
    const result = await collectInboundMedia({ ...message, attachments: [{ type: "file", url: "https://files.example/huge", size: 30 * 1024 * 1024 }] }, "default");
    expect(result.descriptions[0]).toContain("25 МиБ");
    expect(stubs.fetch).not.toHaveBeenCalled();
    stubs.fetch.mockRejectedValue(new Error("signed private URL must not be reflected"));
    const failed = await collectInboundMedia({ ...message, attachments: [{ type: "file", url: "https://files.example/error" }] }, "default");
    expect(failed.descriptions[0]).toContain("не скачан");
    expect(failed.descriptions.join()).not.toContain("signed private URL");
  });
});
