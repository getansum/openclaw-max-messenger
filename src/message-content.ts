import type { InboundAttachment } from "./types.js";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value)
  ? value as JsonRecord : {};
const string = (value: unknown) => typeof value === "string" ? value : undefined;
const SUPPORTED_TYPES = new Set(["image", "video", "audio", "file", "sticker", "contact", "location", "share"]);

export function extractAttachments(value: unknown): InboundAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: InboundAttachment[] = [];
  for (const raw of value) {
    const attachment = record(raw);
    const payload = record(attachment.payload);
    const type = string(attachment.type);
    if (!type || !SUPPORTED_TYPES.has(type)) continue;
    const size = attachment.size ?? payload.size;
    result.push({
      type: type as InboundAttachment["type"],
      url: string(payload.url),
      token: string(payload.token),
      filename: string(attachment.filename) ?? string(payload.filename) ?? string(payload.file_name),
      size: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined,
      mimeType: string(attachment.mime_type) ?? string(payload.mime_type) ?? string(payload.content_type),
      fileId: string(payload.fileId),
    });
  }
  return result.length ? result : undefined;
}

export type MessageContent = {
  text: string;
  commandText: string;
  attachments?: InboundAttachment[];
  forwarded: boolean;
  linkedAttachmentCount: number;
};

/** MAX LinkedMessage.message — MessageBody, а не обязательно полный Message.
 * Не менять отправителя/чат на автора пересылки и не исполнять её текст как команду. */
export function extractMessageContent(value: unknown): MessageContent {
  const message = record(value);
  const body = record(message.body);
  const commandText = string(body.text) ?? "";
  const texts = commandText ? [commandText] : [];
  const attachments = extractAttachments(body.attachments) ?? [];
  let linkedAttachmentCount = 0;
  let forwarded = false;
  let current = message;
  // Ограничить глубину вложенных пересылок/ответов и не обходить произвольный JSON.
  for (let depth = 0; depth < 4; depth++) {
    const link = record(current.link);
    if (link.type !== "forward" && link.type !== "reply") break;
    const linked = record(link.message);
    if (!Object.keys(linked).length) break;
    const linkedBody = linked.body !== undefined ? record(linked.body) : linked;
    const linkedText = string(linkedBody.text);
    const linkedFiles = extractAttachments(linkedBody.attachments) ?? [];
    attachments.push(...linkedFiles);
    linkedAttachmentCount += linkedFiles.length;
    forwarded ||= link.type === "forward";
    if (linkedText || linkedFiles.length) {
      texts.push(`${link.type === "forward" ? "[Пересланное сообщение]" : "[Сообщение, на которое отвечают]"}${linkedText ? `\n${linkedText}` : ""}`);
    }
    current = linked;
  }
  const seen = new Set<string>();
  const unique = attachments.filter(attachment => {
    const identity = attachment.token ?? attachment.url ?? attachment.fileId;
    if (!identity) return true;
    const key = JSON.stringify([attachment.type, identity]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { text: texts.join("\n\n"), commandText, attachments: unique.length ? unique : undefined, forwarded, linkedAttachmentCount };
}
