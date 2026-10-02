import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathInsideRoots, readLocalMedia } from "./media-access.js";

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
