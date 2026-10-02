import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fetchRemoteMedia } from "./media-access.js";
import type { InboundAttachment, InboundMessage } from "./types.js";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const EXTENSIONS: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4",
};
const DEFAULT_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg",
  "image/webp": ".webp", "audio/ogg": ".ogg", "video/mp4": ".mp4",
};

export function inferInboundMime(attachment: InboundAttachment, buffer: Buffer, contentType: string) {
  if (buffer.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(buffer.subarray(0, 6).toString())) return "image/gif";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  const byName = EXTENSIONS[path.extname(attachment.filename || "").toLowerCase()];
  const type = (attachment.mimeType || contentType).split(";")[0].trim();
  return byName || (type && type !== "application/octet-stream" ? type : "application/octet-stream");
}

async function saveFile(buffer: Buffer, attachment: InboundAttachment, mime: string, accountId: string) {
  const dir = path.join(os.homedir(), ".openclaw", "media", "max", accountId);
  await fs.mkdir(dir, { recursive: true });
  const name = path.basename((attachment.filename || attachment.type).replace(/\\/g, "/"))
    .replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "_").slice(0, 180) || "file";
  const extension = path.extname(name) ? "" : DEFAULT_EXTENSIONS[mime] || "";
  const file = path.join(dir, `${Date.now()}-${randomUUID()}-${name}${extension}`);
  await fs.writeFile(file, buffer, { flag: "wx" });
  // Абсолютный канонический путь полезен и для workspace-only read/pdf/view_image.
  return fs.realpath(file);
}

export async function collectInboundMedia(message: InboundMessage, accountId: string) {
  const descriptions: string[] = [];
  const paths: string[] = [];
  const types: string[] = [];
  const attachments = message.attachments ?? [];
  for (const attachment of attachments.slice(0, MAX_ATTACHMENTS)) {
    const label = (attachment.filename || attachment.type).replace(/[\r\n]/g, " ");
    if (attachment.type === "share") {
      descriptions.push(`[Ссылка/предпросмотр, не скачанный файл: ${attachment.url || label}]`);
      continue;
    }
    if (attachment.type === "contact" || attachment.type === "location") {
      descriptions.push(`[Вложение ${attachment.type}: ${label}]`);
      continue;
    }
    if (!attachment.url || !/^https?:\/\//i.test(attachment.url)) {
      descriptions.push(`[Вложение ${attachment.type}: ${label}; файл не скачан: отсутствует HTTP-ссылка]`);
      continue;
    }
    if (attachment.size !== undefined && attachment.size > MAX_BYTES) {
      descriptions.push(`[Вложение ${attachment.type}: ${label}; файл не скачан: превышен лимит 25 МиБ]`);
      continue;
    }
    try {
      const { buffer, contentType } = await fetchRemoteMedia(attachment.url, { maxBytes: MAX_BYTES });
      const mime = inferInboundMime(attachment, buffer, contentType);
      const file = await saveFile(buffer, attachment, mime, accountId);
      paths.push(file); types.push(mime);
      descriptions.push(`[Полученный файл: ${label}; MIME: ${mime}; путь: ${file}]`);
    } catch (error) {
      // Не включать signed URL или произвольное тело ошибки в prompt/log.
      descriptions.push(`[Вложение ${attachment.type}: ${label}; файл не скачан (${error instanceof Error ? error.name : "ошибка"})]`);
    }
  }
  if (attachments.length > MAX_ATTACHMENTS) descriptions.push(`[Обработаны первые ${MAX_ATTACHMENTS} из ${attachments.length} вложений]`);
  return { descriptions, paths, types };
}
