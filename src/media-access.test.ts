import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const remote = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: remote.fetch }));
import { isPathInsideRoots, readLocalMedia, fetchRemoteMedia } from "./media-access.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "max-media-test-"));
  temporary.push(dir);
  const managed = path.join(dir, "workspace", "media", "managed");
  fs.mkdirSync(managed, { recursive: true });
  const alias = path.join(dir, "legacy-media");
  fs.symlinkSync(managed, alias, "dir");
  const file = path.join(managed, "report.pdf");
  fs.writeFileSync(file, "PDF fixture");
  return { dir, managed, alias, file };
}

describe("canonical media roots", () => {
  it("reads a staged PDF through an alias whose target is an allowed canonical root", async () => {
    const { managed, alias } = fixture();
    const input = path.join(alias, "report.pdf");
    expect(isPathInsideRoots(input, [managed])).toBe(true);
    expect((await readLocalMedia(input, { mediaLocalRoots: [managed] })).toString()).toBe("PDF fixture");
  });

  it("rejects a symlink inside an allowed root that points outside it", async () => {
    const { dir, managed } = fixture();
    const outside = path.join(dir, "private.json");
    fs.writeFileSync(outside, "private fixture");
    const link = path.join(managed, "outside.pdf");
    fs.symlinkSync(outside, link);
    expect(isPathInsideRoots(link, [managed])).toBe(false);
    await expect(readLocalMedia(link, { mediaLocalRoots: [managed] })).rejects.toThrow("outside the media roots");
  });

  it("prefers the host reader so the caller's authorization remains authoritative", async () => {
    const { file } = fixture();
    await expect(readLocalMedia(file, {
      mediaReadFile: async () => { throw new Error("host denied"); },
      mediaLocalRoots: [path.dirname(file)],
    })).rejects.toThrow("host denied");
  });
});

describe("bounded inbound download", () => {
  it("rejects a declared oversize without reading its body and releases the connection", async () => {
    const release = vi.fn();
    remote.fetch.mockResolvedValue({ response: new Response("content", { headers: { "content-length": "100" } }), release });
    await expect(fetchRemoteMedia("https://files.example/large", { maxBytes: 4 })).rejects.toThrow("size limit");
    expect(release).toHaveBeenCalledOnce();
  });
  it("enforces the stream limit when Content-Length is absent or misleading", async () => {
    const release = vi.fn();
    remote.fetch.mockResolvedValue({ response: new Response("123456", { headers: { "content-length": "1" } }), release });
    await expect(fetchRemoteMedia("https://files.example/stream", { maxBytes: 4 })).rejects.toThrow("size limit");
    expect(release).toHaveBeenCalledOnce();
  });
  it("returns complete bytes within the limit with their Content-Type", async () => {
    const release = vi.fn();
    remote.fetch.mockResolvedValue({ response: new Response("1234", { headers: { "content-type": "application/pdf" } }), release });
    const result = await fetchRemoteMedia("https://files.example/small", { maxBytes: 4 });
    expect(result.buffer.toString()).toBe("1234");
    expect(result.contentType).toBe("application/pdf");
    expect(release).toHaveBeenCalledOnce();
  });
});
