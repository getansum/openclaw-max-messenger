import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaxActivityTracker, sendMaxAction, type MaxActivityAction } from "./activity.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const account = { token: "fixture", typingIntervalMs: 4000 };

describe("activity lifecycle", () => {
  it("marks read once, refreshes typing, and stops after release", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tracker = new MaxActivityTracker(send);
    const stop = await tracker.begin("default", account, 10, vi.fn());
    expect(send.mock.calls.map(call => call[2])).toEqual(["mark_seen", "typing_on"]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(send.mock.calls.filter(call => call[2] === "typing_on")).toHaveLength(3);
    stop(); stop();
    const count = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(send).toHaveBeenCalledTimes(count);
    expect(send.mock.calls[0][3].aborted).toBe(true);
  });

  it("keeps typing until both overlapping turns in the same chat finish", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tracker = new MaxActivityTracker(send);
    const first = await tracker.begin("default", account, 10, vi.fn());
    const second = await tracker.begin("default", account, 10, vi.fn());
    first();
    await vi.advanceTimersByTimeAsync(4000);
    expect(send.mock.calls.filter(call => call[2] === "typing_on")).toHaveLength(2);
    second();
    await vi.advanceTimersByTimeAsync(4000);
    expect(send.mock.calls.filter(call => call[2] === "typing_on")).toHaveLength(2);
  });

  it("isolates accounts and recipients and stops only the selected account", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tracker = new MaxActivityTracker(send);
    const a = await tracker.begin("a", account, 10, vi.fn());
    const b = await tracker.begin("b", { ...account, token: "other-fixture" }, 10, vi.fn());
    const c = await tracker.begin("a", account, 20, vi.fn());
    tracker.stopAccount("a");
    const start = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(send.mock.calls.slice(start).map(call => [call[0].token, call[1], call[2]]))
      .toEqual([["other-fixture", 10, "typing_on"]]);
    a(); b(); c();
  });

  it("aborts an in-flight refresh when the turn ends", async () => {
    let count = 0;
    let signal: AbortSignal | undefined;
    const send = vi.fn(async (_account, _chat, action, currentSignal) => {
      if (action === "typing_on" && ++count === 2) {
        signal = currentSignal;
        await new Promise<void>((_resolve, reject) => {
          currentSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    });
    const warnings = vi.fn();
    const tracker = new MaxActivityTracker(send);
    const stop = await tracker.begin("default", account, 10, warnings);
    await vi.advanceTimersByTimeAsync(4000);
    stop();
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("logs optional action failures without blocking a reply or leaking arbitrary errors", async () => {
    const send = vi.fn().mockRejectedValue(new Error("transport reflected private fixture"));
    const warnings = vi.fn();
    const tracker = new MaxActivityTracker(send);
    const stop = await tracker.begin("default", account, 10, warnings);
    expect(warnings).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private fixture");
    stop();
  });

  it("honors disabled read receipts and typing", async () => {
    const send = vi.fn();
    const tracker = new MaxActivityTracker(send);
    const stop = await tracker.begin("default", { ...account, readReceipts: false, typingEnabled: false }, 10, vi.fn());
    await vi.advanceTimersByTimeAsync(12000);
    expect(send).not.toHaveBeenCalled();
    stop();
  });
});

describe("MAX action transport", () => {
  it("uses the current API host, Authorization header, JSON action and caller signal", async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    await sendMaxAction(account, 10, "typing_on", controller.signal);
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe("https://platform-api2.max.ru/chats/10/actions");
    expect(options.headers.Authorization).toBe("fixture");
    expect(JSON.parse(options.body)).toEqual({ action: "typing_on" });
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });

  it("respects a relay prefix and refuses unsuccessful HTTP-200 acknowledgements", async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"success":false}', { status: 200 }));
    vi.stubGlobal("fetch", request);
    await expect(sendMaxAction({ ...account, apiBaseUrl: "https://relay.example/api" }, 10, "mark_seen"))
      .rejects.toThrow("API did not confirm success");
    expect(String(request.mock.calls[0][0])).toBe("https://relay.example/api/chats/10/actions");
  });
});
