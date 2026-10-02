import fs from "node:fs";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

/** Host-supplied file access, as it arrives on outbound send contexts. */
export type MediaAccessContext = {
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  mediaLocalRoots?: readonly string[];
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
    workspaceDir?: string;
  };
};

export function isPathInsideRoots(filePath: string, roots: readonly string[]): boolean {
  if (!roots.length) return false;
  // SDK выдаёт канонические roots, но staged-вложение может иметь старый
  // путь через alias. Канонизировать обе стороны и проверить именно цель ссылки.
  const canonical = (value: string) => fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value);
  const resolved = canonical(filePath);
  return roots.some((root) => {
    const normalized = canonical(root);
    return resolved === normalized || resolved.startsWith(normalized + path.sep);
  });
}

/**
 * Read a local file only through the reader the host provides, or from inside
 * the roots it allows. Without either, reading is refused: an agent can put an
 * arbitrary path in a media field, and the gateway config sits on the same disk.
 */
export async function readLocalMedia(
  filePath: string,
  ctx: MediaAccessContext,
): Promise<Buffer> {
  const readFile = ctx.mediaReadFile ?? ctx.mediaAccess?.readFile;
  if (readFile) return readFile(filePath);

  const roots = ctx.mediaLocalRoots ?? ctx.mediaAccess?.localRoots ?? [];
  if (!isPathInsideRoots(filePath, roots)) {
    throw new Error(
      `Refusing to read "${filePath}": outside the media roots allowed for this send`,
    );
  }
  return fs.promises.readFile(filePath);
}

/** Fetch remote media through the SDK guard so a URL cannot reach internal hosts. */
export async function fetchRemoteMedia(
  url: string,
  options: { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string }> {
  const { response, release } = await fetchWithSsrFGuard({ url });
  try {
    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.status}`);
    }
    const maxBytes = options.maxBytes;
    const length = Number(response.headers.get("content-length"));
    if (maxBytes !== undefined && length > maxBytes) throw new Error("Media exceeds size limit");
    let buffer: Buffer;
    if (maxBytes !== undefined && response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error("Media exceeds size limit");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      buffer = Buffer.concat(chunks, bytes);
    } else buffer = Buffer.from(await response.arrayBuffer());
    if (maxBytes !== undefined && buffer.byteLength > maxBytes) throw new Error("Media exceeds size limit");
    return {
      buffer,
      contentType: response.headers.get("content-type") || "",
    };
  } finally {
    await release();
  }
}
