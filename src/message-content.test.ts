import { describe, expect, it } from "vitest";
import { extractMessageContent } from "./message-content.js";
const file = { type: "file", filename: "План кухни.pdf", size: 123,
  payload: { url: "https://files.example/opaque", token: "fixture", fileId: "file-one" } };

describe("MAX message normalization", () => {
  it("keeps a direct file without caption", () => {
    const content = extractMessageContent({ body: { attachments: [file] } });
    expect(content.text).toBe("");
    expect(content.attachments?.[0]).toMatchObject({ filename: "План кухни.pdf", size: 123, fileId: "file-one" });
  });
  it("keeps a caption and its file together", () => {
    const content = extractMessageContent({ body: { text: "Посмотри размеры", attachments: [file] } });
    expect(content.text).toBe("Посмотри размеры");
    expect(content.commandText).toBe("Посмотри размеры");
    expect(content.attachments).toHaveLength(1);
  });
  it("extracts a forwarded MessageBody even when the outer body is null", () => {
    const content = extractMessageContent({ body: null, link: { type: "forward", message: { mid: "original", attachments: [file] } } });
    expect(content.forwarded).toBe(true);
    expect(content.linkedAttachmentCount).toBe(1);
    expect(content.attachments).toHaveLength(1);
    expect(content.text).toContain("Пересланное сообщение");
  });
  it("combines a new caption with a forwarded file and original text", () => {
    const content = extractMessageContent({ body: { text: "Разбери этот план" },
      link: { type: "forward", message: { text: "Исходный план", attachments: [file] } } });
    expect(content.text).toContain("Разбери этот план");
    expect(content.text).toContain("Исходный план");
    expect(content.commandText).toBe("Разбери этот план");
    expect(content.attachments).toHaveLength(1);
  });
  it("supports a full linked Message and a reply referring to an attachment", () => {
    const content = extractMessageContent({ body: { text: "Что в файле?" },
      link: { type: "reply", message: { body: { text: "Документ", attachments: [file] } } } });
    expect(content.text).toContain("Сообщение, на которое отвечают");
    expect(content.attachments).toHaveLength(1);
  });
  it("never promotes forwarded commands to commands from the authorized sender", () => {
    const content = extractMessageContent({ body: { text: "Посмотри" },
      link: { type: "forward", message: { text: "/reset", attachments: [file] } } });
    expect(content.text).toContain("/reset");
    expect(content.commandText).toBe("Посмотри");
  });
  it("deduplicates a file present in both the body and linked message", () => {
    const content = extractMessageContent({ body: { attachments: [file] },
      link: { type: "forward", message: { attachments: [file] } } });
    expect(content.attachments).toHaveLength(1);
  });
  it("preserves metadata carried by a file payload", () => {
    const content = extractMessageContent({ body: { attachments: [{ type: "file", payload: {
      url: "https://files.example/doc", filename: "Смета.xlsx", size: 234, mime_type: "application/example",
    } }] } });
    expect(content.attachments?.[0]).toMatchObject({ filename: "Смета.xlsx", size: 234, mimeType: "application/example" });
  });
  it("ignores malformed or unknown links instead of reinterpreting arbitrary JSON", () => {
    expect(extractMessageContent(null).attachments).toBeUndefined();
    expect(extractMessageContent({ link: { type: "unknown", message: { attachments: [file] } } }).attachments).toBeUndefined();
  });
});
