import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  bot: {
    start: vi.fn(async (options?: { onStart?: () => void }) => {
      options?.onStart?.();
    }),
    stop: vi.fn(),
  },
  createBot: vi.fn(),
  registerCommands: vi.fn().mockResolvedValue(undefined),
  loadConfig: vi.fn(),
  registry: {
    dispose: vi.fn(),
  },
  registryCreate: vi.fn(),
}));

vi.mock("../src/bot.js", () => ({
  createBot: mockState.createBot,
  registerCommands: mockState.registerCommands,
}));

vi.mock("../src/config.js", () => ({
  loadConfig: mockState.loadConfig,
}));

vi.mock("../src/pi-session.js", () => ({
  PiSessionRegistry: {
    create: mockState.registryCreate,
  },
}));

import { startBot } from "../src/index.js";

describe("TelePi entrypoint", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const processOnceSpy = vi.spyOn(process, "once").mockImplementation(() => process);

  beforeEach(() => {
    mockState.bot.start.mockClear();
    mockState.bot.stop.mockClear();
    mockState.createBot.mockReset();
    mockState.registerCommands.mockClear();
    mockState.loadConfig.mockReset();
    mockState.registry.dispose.mockClear();
    mockState.registryCreate.mockReset();
    logSpy.mockClear();
    processOnceSpy.mockClear();

    mockState.createBot.mockReturnValue(mockState.bot);
    mockState.registryCreate.mockResolvedValue(mockState.registry);
    mockState.loadConfig.mockReturnValue({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123],
      telegramAllowedUserIdSet: new Set([123]),
      workspace: "/workspace",
      toolVerbosity: "summary",
      uploadsDir: "/tmp/telepi-uploads",
      promptInboxIntervalMs: 60000,
    });
  });

  afterEach(() => {
    processOnceSpy.mockImplementation(() => process);
  });

  it("preserves Telegram updates queued while TelePi is restarting", async () => {
    await startBot();

    expect(mockState.bot.start).toHaveBeenCalledWith(
      expect.objectContaining({
        drop_pending_updates: false,
      }),
    );
  });
});
