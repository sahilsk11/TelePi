/**
 * Persists the Telegram context-key → active session-file mapping to disk.
 *
 * Used as a fallback when TelePi restarts: the in-memory registry starts empty
 * after each process restart, so the last-known session for each chat is loaded
 * from this store instead of creating a fresh empty session.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ChatSessionEntry {
  sessionFile: string;
  workspace: string;
}

interface StoreData {
  version: 1;
  entries: Record<string, ChatSessionEntry>;
}

export class ChatSessionStore {
  private readonly entries: Map<string, ChatSessionEntry>;

  private constructor(
    private readonly storePath: string,
    entries: Map<string, ChatSessionEntry>,
  ) {
    this.entries = entries;
  }

  /**
   * Load the store from disk. Returns an empty store if the file is missing or corrupt.
   */
  static load(storePath: string): ChatSessionStore {
    const entries = new Map<string, ChatSessionEntry>();
    try {
      if (existsSync(storePath)) {
        const raw = readFileSync(storePath, "utf8");
        const data: unknown = JSON.parse(raw);
        if (
          data !== null &&
          typeof data === "object" &&
          (data as StoreData).version === 1 &&
          typeof (data as StoreData).entries === "object" &&
          (data as StoreData).entries !== null
        ) {
          for (const [key, value] of Object.entries((data as StoreData).entries)) {
            if (
              value !== null &&
              typeof value === "object" &&
              typeof (value as ChatSessionEntry).sessionFile === "string" &&
              typeof (value as ChatSessionEntry).workspace === "string"
            ) {
              entries.set(key, {
                sessionFile: (value as ChatSessionEntry).sessionFile,
                workspace: (value as ChatSessionEntry).workspace,
              });
            }
          }
        }
      }
    } catch {
      // Corrupt or missing store — start fresh.
    }

    return new ChatSessionStore(storePath, entries);
  }

  get(contextKey: string): ChatSessionEntry | undefined {
    return this.entries.get(contextKey);
  }

  set(contextKey: string, entry: ChatSessionEntry): void {
    const existing = this.entries.get(contextKey);
    if (existing?.sessionFile === entry.sessionFile && existing?.workspace === entry.workspace) {
      return;
    }
    this.entries.set(contextKey, entry);
    this.flush();
  }

  delete(contextKey: string): void {
    if (!this.entries.has(contextKey)) {
      return;
    }
    this.entries.delete(contextKey);
    this.flush();
  }

  /**
   * Write the store atomically (temp file → rename) to avoid partial writes.
   */
  private flush(): void {
    try {
      const dir = path.dirname(this.storePath);
      mkdirSync(dir, { recursive: true });

      const data: StoreData = {
        version: 1,
        entries: Object.fromEntries(this.entries),
      };

      const tempPath = path.join(
        tmpdir(),
        `telepi-chat-sessions-${process.pid}-${Date.now()}.json.tmp`,
      );
      writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
      renameSync(tempPath, this.storePath);
    } catch (error) {
      console.error("Failed to persist chat session store:", error);
    }
  }
}
