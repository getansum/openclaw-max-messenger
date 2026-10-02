import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({
  dispatch: vi.fn(),
  access: vi.fn(),
  challenge: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/inbound-reply-dispatch", () => ({ dispatchInboundReplyWithBase: stubs.dispatch }));
vi.mock("openclaw/plugin-sdk/channel-policy", () => ({ resolveDmGroupAccessWithLists: stubs.access }));
vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingController: () => ({ readAllowFromStore: async () => [], issueChallenge: stubs.challenge }),
}));
vi.mock("openclaw/plugin-sdk/media-local-roots", () => ({ getAgentScopedMediaLocalRoots: () => [] }));
import { handleMaxInbound } from "./inbound.js";
import { setMaxRuntime, clearMaxRuntime } from "./runtime.js";
import { maxActivity } from "./activity.js";

const account = { token: "fixture", dmPolicy: "allowlist", allowFrom: ["sender"] };
const message = {
  channel: "max", accountId: "default", chatId: "100", userId: "sender",
  messageId: "message", text: "hello", timestamp: 1000,
};
let stop: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  stop = vi.fn();
  vi.spyOn(maxActivity, "begin").mockResolvedValue(stop);
  stubs.access.mockReturnValue({ decision: "allow" });
  stubs.dispatch.mockResolvedValue(undefined);
  setMaxRuntime({
    config: { current: () => ({}) },
    channel: {
      routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: "agent:main:test", accountId: "default" }) },
      session: { resolveStorePath: () => "unused", readSessionUpdatedAt: () => undefined },
      reply: { resolveEnvelopeFormatOptions: () => ({}), formatAgentEnvelope: (x: any) => x.body, finalizeInboundContext: (x: any) => x },
    },
  } as any);
});
afterEach(() => { vi.restoreAllMocks(); clearMaxRuntime(); });

describe("inbound activity authorization and teardown", () => {
  it("does not mark read or type for a blocked sender", async () => {
    stubs.access.mockReturnValue({ decision: "block" });
    await handleMaxInbound({ message, account, accountId: "default" });
    expect(maxActivity.begin).not.toHaveBeenCalled();
    expect(stubs.dispatch).not.toHaveBeenCalled();
  });

  it("does not start activity while issuing a pairing challenge", async () => {
    stubs.access.mockReturnValue({ decision: "pairing" });
    await handleMaxInbound({ message, account, accountId: "default" });
    expect(stubs.challenge).toHaveBeenCalledOnce();
    expect(maxActivity.begin).not.toHaveBeenCalled();
  });

  it("starts activity for the exact authorized chat and releases it after a silent reply", async () => {
    await handleMaxInbound({ message, account, accountId: "default" });
    expect(maxActivity.begin).toHaveBeenCalledWith("default", account, 100, expect.any(Function));
    expect(stubs.dispatch).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("releases typing even when agent dispatch fails", async () => {
    stubs.dispatch.mockRejectedValue(new Error("model failed"));
    await expect(handleMaxInbound({ message, account, accountId: "default" })).rejects.toThrow("model failed");
    expect(stop).toHaveBeenCalledOnce();
  });
});
