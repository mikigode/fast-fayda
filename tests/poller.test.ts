import { describe, expect, it, vi } from "vitest";
import { createPoller, type PollTransport } from "@/poller";
import type { BotDeps, TgUpdate } from "@/bot/router";

/**
 * The polling loop, driven without a network.
 *
 * What is protected here is the offset: it is Telegram's only record of what
 * this bot has seen. Advancing it past an update that was never handled loses
 * that update permanently, and never advancing it replays the same message
 * forever.
 */

process.env.ID_HASH_SECRET = "test-id-hash-secret-that-is-long-enough-32";

function update(id: number): TgUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: 7, type: "private" },
      from: { id: 7, first_name: "Test" },
      text: "hello",
    },
  };
}

/**
 * Deps that record nothing and answer everything — this suite is about the
 * loop, not the conversation, which tests/bot.test.ts already covers.
 */
function stubDeps(onHandle: (u: TgUpdate) => void = () => {}): BotDeps {
  return {
    store: {
      claimUpdate: async (id: number) => {
        onHandle(update(id));
        return false; // stops before the conversation; the loop is what matters
      },
    } as unknown as BotDeps["store"],
    api: {} as BotDeps["api"],
    provider: { name: "none", async lookup() { return { outcome: "unavailable" }; } },
    cards: {} as BotDeps["cards"],
    supportChatId: null,
    newUserGroupId: null,
    pricePerPoint: 15,
    fetchReceipt: async () => null,
    adminIds: [],
    adminContact: "@admin",
  };
}

/** A transport that serves scripted batches and then blocks the loop. */
function scriptedTransport(batches: TgUpdate[][]): PollTransport & { offsets: number[] } {
  const offsets: number[] = [];
  let call = 0;
  return {
    offsets,
    async getUpdates(offset) {
      offsets.push(offset);
      const batch = batches[call++];
      if (!batch) throw new Error("no more batches");
      return batch;
    },
    async deleteWebhook() {},
    async getMe() {
      return { username: "testbot" };
    },
  };
}

describe("createPoller", () => {
  it("confirms updates by advancing the offset past the last one handled", async () => {
    const handled: number[] = [];
    const transport = scriptedTransport([[update(10), update(11)], [update(12)]]);
    const poller = createPoller(stubDeps((u) => handled.push(u.update_id)), transport, async () => {
      poller.stop();
    });

    await poller.start();

    expect(handled).toEqual([10, 11, 12]);
    // First ask is from 0; then past 11; then past 12.
    expect(transport.offsets.slice(0, 3)).toEqual([0, 12, 13]);
  });

  it("clears a registered webhook before polling", async () => {
    let cleared = false;
    const transport = scriptedTransport([[]]);
    transport.deleteWebhook = async () => {
      cleared = true;
    };
    const poller = createPoller(stubDeps(), transport, async () => {
      poller.stop();
    });

    await poller.start();
    expect(cleared).toBe(true);
  });

  /**
   * A failing update must not hold the offset still. If it did, the same
   * message would be redelivered forever and nothing behind it would ever be
   * seen.
   */
  it("advances past an update whose handling threw", async () => {
    const transport = scriptedTransport([[update(20)], [update(21)]]);
    const deps = stubDeps();
    deps.store.claimUpdate = async () => {
      throw new Error("handler exploded");
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const poller = createPoller(deps, transport, async () => {
      poller.stop();
    });
    await poller.start();

    expect(transport.offsets).toContain(21);
    errors.mockRestore();
  });

  it("backs off after a failed poll instead of hammering", async () => {
    const waits: number[] = [];
    let calls = 0;
    const transport: PollTransport = {
      async getUpdates() {
        calls += 1;
        throw new Error("network down");
      },
      async deleteWebhook() {},
      async getMe() {
        return { username: "testbot" };
      },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const poller = createPoller(stubDeps(), transport, async (ms) => {
      waits.push(ms);
      if (waits.length >= 3) poller.stop();
    });
    await poller.start();

    expect(calls).toBe(3);
    // Doubling, so an outage costs a handful of requests rather than thousands.
    expect(waits).toEqual([1000, 2000, 4000]);
    errors.mockRestore();
  });

  it("names the 409 case, because two pollers fight invisibly otherwise", async () => {
    const messages: unknown[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((...args) => {
      messages.push(args.join(" "));
    });
    const transport: PollTransport = {
      async getUpdates() {
        throw new Error("getUpdates failed (409): Conflict: terminated by other getUpdates request");
      },
      async deleteWebhook() {},
      async getMe() {
        return { username: "testbot" };
      },
    };

    const poller = createPoller(stubDeps(), transport, async () => {
      poller.stop();
    });
    await poller.start();

    expect(messages.join(" ")).toContain("Another process is polling this bot");
    errors.mockRestore();
  });

  /**
   * Found by running it: the identity call is the first thing polling does over
   * the network, and letting it throw ended the process — health server and
   * all — before a single poll. On a host that restarts on exit, one blip at
   * boot becomes a crash loop.
   */
  it("polls even when the identity call fails at startup", async () => {
    const transport = scriptedTransport([[update(30)]]);
    transport.getMe = async () => {
      throw new Error("network down at boot");
    };
    const handled: number[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const deps = stubDeps((u) => handled.push(u.update_id));
    const poller = createPoller(deps, transport, async () => {
      poller.stop();
    });
    await expect(poller.start()).resolves.toBeUndefined();

    expect(handled).toEqual([30]);
    warn.mockRestore();
    vi.restoreAllMocks();
  });

  it("stops when asked", async () => {
    const transport = scriptedTransport([[], [], []]);
    const poller = createPoller(stubDeps(), transport, async () => {});
    const run = poller.start();
    poller.stop();
    await run;

    // One poll may already have been in flight; it must not keep going.
    expect(transport.offsets.length).toBeLessThanOrEqual(2);
  });
});
