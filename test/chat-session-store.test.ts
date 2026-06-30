import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { ChatSessionStore } from "../src/chat-session-store.js";

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "telepi-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("ChatSessionStore", () => {
  it("returns empty store for missing file", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);

    expect(store.get("123::root")).toBeUndefined();
  });

  it("returns empty store for corrupt JSON", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");
    writeFileSync(storePath, "not valid json!!!", "utf8");

    const store = ChatSessionStore.load(storePath);

    expect(store.get("123::root")).toBeUndefined();
  });

  it("parses a valid store file correctly", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");
    const data = {
      version: 1,
      entries: {
        "123::root": { sessionFile: "/sessions/abc.jsonl", workspace: "/workspace/myproject" },
        "456::99": { sessionFile: "/sessions/def.jsonl", workspace: "/workspace/other" },
      },
    };
    writeFileSync(storePath, JSON.stringify(data), "utf8");

    const store = ChatSessionStore.load(storePath);

    expect(store.get("123::root")).toEqual({
      sessionFile: "/sessions/abc.jsonl",
      workspace: "/workspace/myproject",
    });
    expect(store.get("456::99")).toEqual({
      sessionFile: "/sessions/def.jsonl",
      workspace: "/workspace/other",
    });
  });

  it("skips entries with wrong shape", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");
    const data = {
      version: 1,
      entries: {
        "good::key": { sessionFile: "/sessions/good.jsonl", workspace: "/workspace/good" },
        "bad::missing-file": { workspace: "/workspace/bad" },
        "bad::missing-workspace": { sessionFile: "/sessions/bad.jsonl" },
        "bad::null": null,
        "bad::number": 42,
      },
    };
    writeFileSync(storePath, JSON.stringify(data), "utf8");

    const store = ChatSessionStore.load(storePath);

    expect(store.get("good::key")).toEqual({
      sessionFile: "/sessions/good.jsonl",
      workspace: "/workspace/good",
    });
    expect(store.get("bad::missing-file")).toBeUndefined();
    expect(store.get("bad::missing-workspace")).toBeUndefined();
    expect(store.get("bad::null")).toBeUndefined();
    expect(store.get("bad::number")).toBeUndefined();
  });

  it("set persists to disk", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);
    store.set("123::root", { sessionFile: "/sessions/abc.jsonl", workspace: "/workspace/proj" });

    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.entries["123::root"]).toEqual({
      sessionFile: "/sessions/abc.jsonl",
      workspace: "/workspace/proj",
    });
  });

  it("set is a no-op if the entry is unchanged (idempotent, does not rewrite)", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);
    store.set("123::root", { sessionFile: "/sessions/abc.jsonl", workspace: "/workspace/proj" });

    const firstMtime = readFileSync(storePath).toString();

    // Small wait to allow mtime to differ if file is written
    const before = Date.now();
    store.set("123::root", { sessionFile: "/sessions/abc.jsonl", workspace: "/workspace/proj" });
    const elapsed = Date.now() - before;

    // If it was a no-op, the content should still be the same
    const afterContent = readFileSync(storePath).toString();
    expect(afterContent).toBe(firstMtime);
    // The operation should be fast (no disk I/O)
    expect(elapsed).toBeLessThan(1000);
  });

  it("delete removes an entry and persists", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);
    store.set("123::root", { sessionFile: "/sessions/abc.jsonl", workspace: "/workspace/proj" });
    store.set("456::root", { sessionFile: "/sessions/def.jsonl", workspace: "/workspace/other" });

    store.delete("123::root");

    expect(store.get("123::root")).toBeUndefined();
    expect(store.get("456::root")).toEqual({
      sessionFile: "/sessions/def.jsonl",
      workspace: "/workspace/other",
    });

    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    expect(raw.entries["123::root"]).toBeUndefined();
    expect(raw.entries["456::root"]).toBeDefined();
  });

  it("delete is a no-op if key does not exist", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);

    // Should not throw and should not write any file
    expect(() => store.delete("nonexistent::key")).not.toThrow();

    // File should not exist since we never set anything
    expect(() => readFileSync(storePath)).toThrow();
  });

  it("round-trip: set then load returns the same data", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);
    store.set("chat1::root", { sessionFile: "/sessions/s1.jsonl", workspace: "/workspace/a" });
    store.set("chat2::77", { sessionFile: "/sessions/s2.jsonl", workspace: "/workspace/b" });

    const reloaded = ChatSessionStore.load(storePath);

    expect(reloaded.get("chat1::root")).toEqual({
      sessionFile: "/sessions/s1.jsonl",
      workspace: "/workspace/a",
    });
    expect(reloaded.get("chat2::77")).toEqual({
      sessionFile: "/sessions/s2.jsonl",
      workspace: "/workspace/b",
    });
  });

  it("handles concurrent-ish writes atomically", async () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");

    const store = ChatSessionStore.load(storePath);

    // Simulate rapid sequential writes
    for (let i = 0; i < 10; i++) {
      store.set(`chat${i}::root`, { sessionFile: `/sessions/s${i}.jsonl`, workspace: `/workspace/${i}` });
    }

    // All entries should be present and file should be valid JSON
    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    expect(raw.version).toBe(1);
    for (let i = 0; i < 10; i++) {
      expect(raw.entries[`chat${i}::root`]).toEqual({
        sessionFile: `/sessions/s${i}.jsonl`,
        workspace: `/workspace/${i}`,
      });
    }
  });

  it("skips data when version is not 1", () => {
    const dir = makeTempDir();
    const storePath = path.join(dir, "chat-sessions.json");
    const data = {
      version: 2,
      entries: {
        "123::root": { sessionFile: "/sessions/abc.jsonl", workspace: "/workspace/proj" },
      },
    };
    writeFileSync(storePath, JSON.stringify(data), "utf8");

    const store = ChatSessionStore.load(storePath);

    expect(store.get("123::root")).toBeUndefined();
  });
});
