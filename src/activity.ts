import type { MaxAccountConfig } from "./types.js";

export type MaxActivityAction = "typing_on" | "mark_seen";
type Warn = (message: string) => void;
class MaxActionError extends Error {}
export type ActionSender = (
  account: MaxAccountConfig,
  chatId: number,
  action: MaxActivityAction,
  signal?: AbortSignal,
) => Promise<void>;

/** Документированный typing_on и проверенный сервером, но не описанный
 * публичной спецификацией mark_seen. Ошибки не содержат токена/тела ответа. */
export const sendMaxAction: ActionSender = async (account, chatId, action, signal) => {
  const base = new URL(account.apiBaseUrl || "https://platform-api2.max.ru/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const response = await fetch(new URL(`chats/${chatId}/actions`, base), {
    method: "POST",
    headers: { Authorization: account.token, "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
    signal: requestSignal,
  });
  if (!response.ok) throw new MaxActionError(`HTTP ${response.status}`);
  const result = await response.json() as { success?: boolean };
  if (result.success !== true) throw new MaxActionError("API did not confirm success");
};

type ActivityState = {
  references: number;
  controller: AbortController;
  timer?: ReturnType<typeof setInterval>;
  pending: boolean;
};

/** Одна петля на аккаунт/чат. Параллельные ходы не гасят друг другу typing. */
export class MaxActivityTracker {
  private readonly states = new Map<string, ActivityState>();

  constructor(private readonly send: ActionSender = sendMaxAction) {}

  async begin(accountId: string, account: MaxAccountConfig, chatId: number, warn: Warn) {
    const key = JSON.stringify([accountId, chatId]);
    let state = this.states.get(key);
    if (!state) {
      state = { references: 0, controller: new AbortController(), pending: false };
      this.states.set(key, state);
    }
    state.references++;
    const current = state;
    const release = () => {
      if (this.states.get(key) !== current) return;
      if (--current.references > 0) return;
      this.dispose(key, current);
    };
    const notify = async (action: MaxActivityAction) => {
      try { await this.send(account, chatId, action, current.controller.signal); }
      catch (error) {
        if (!current.controller.signal.aborted) {
          // Не выводить произвольный Error: транспорт может включать credentials.
          const reason = error instanceof MaxActionError ? error.message
            : error instanceof Error ? error.name : "unknown error";
          warn(`MAX ${action} failed (account=${accountId}, chat=${chatId}, ${reason})`);
        }
      }
    };
    const tick = async () => {
      if (current.pending || current.controller.signal.aborted || account.typingEnabled === false) return;
      current.pending = true;
      try { await notify("typing_on"); }
      finally { current.pending = false; }
    };
    // Статусные запросы не задерживают начало ответа при плохой сети.
    if (account.readReceipts !== false) void notify("mark_seen");
    if (!current.timer && account.typingEnabled !== false && !current.controller.signal.aborted) {
      current.timer = setInterval(() => { void tick(); }, account.typingIntervalMs ?? 4000);
      current.timer.unref?.();
      void tick();
    }
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  }

  stopAccount(accountId: string) {
    for (const [key, state] of this.states) {
      if ((JSON.parse(key) as [string, number])[0] === accountId) this.dispose(key, state);
    }
  }

  private dispose(key: string, state: ActivityState) {
    if (state.timer) clearInterval(state.timer);
    state.controller.abort();
    this.states.delete(key);
  }
}

export const maxActivity = new MaxActivityTracker();
