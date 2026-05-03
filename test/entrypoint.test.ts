import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isEntrypoint } from "../src/entrypoint.js";

describe("entrypoint detection", () => {
  it("treats symlinked bin paths as the real module entrypoint", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telepi-entrypoint-"));
    const realCliPath = path.join(directory, "node_modules", "@futurelab-studio", "telepi", "dist", "cli.js");
    const symlinkPath = path.join(directory, "bin", "telepi");

    mkdirSync(path.dirname(realCliPath), { recursive: true });
    mkdirSync(path.dirname(symlinkPath), { recursive: true });
    writeFileSync(realCliPath, "#!/usr/bin/env node\n", { flag: "wx" });
    symlinkSync(realCliPath, symlinkPath);

    expect(isEntrypoint(pathToFileURL(realCliPath).href, symlinkPath)).toBe(true);
  });

  it("rejects missing or unrelated argv paths", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "telepi-entrypoint-"));
    const modulePath = path.join(directory, "cli.js");
    const otherPath = path.join(directory, "other.js");

    writeFileSync(modulePath, "", { flag: "wx" });
    writeFileSync(otherPath, "", { flag: "wx" });

    expect(isEntrypoint(pathToFileURL(modulePath).href, undefined)).toBe(false);
    expect(isEntrypoint(pathToFileURL(modulePath).href, otherPath)).toBe(false);
  });
});
