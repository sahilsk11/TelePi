import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import {
  DOCKER_WORKSPACE_PATH,
  getDefaultTelePiConfigPath,
  getDefaultTelePiUploadsDir,
  resolvePathFromCwd,
} from "./paths.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";

export interface TelePiConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  piProfile?: ResolvedPiAgentProfile;
  workspace: string;
  piSessionPath?: string;
  piSessionDir?: string;
  piModel?: string;
  piTools?: string[];
  toolVerbosity: ToolVerbosity;
  uploadsDir: string;
  promptInboxDir?: string;
  promptInboxIntervalMs: number;
}

export type TelePiConfigPathSource = "explicit" | "default" | "cwd" | "missing";

export interface TelePiConfigPathInfo {
  explicitPath?: string;
  defaultPath: string;
  localPath: string;
  resolvedPath?: string;
  source: TelePiConfigPathSource;
}

export interface ResolvedPiAgentProfile {
  id?: string;
  path: string;
  agentDir?: string;
  sessionDir?: string;
  workspace?: string;
  requiredEnv?: string[];
  tools?: string[];
}

interface PiAgentProfileFile {
  id?: unknown;
  agentDir?: unknown;
  sessionDir?: unknown;
  workspace?: unknown;
  defaultWorkspace?: unknown;
  requiredEnv?: unknown;
  tools?: unknown;
}

const DEFAULT_PROMPT_INBOX_INTERVAL_MS = 60_000;
const MIN_PROMPT_INBOX_INTERVAL_MS = 1_000;

export function loadConfig(): TelePiConfig {
  const envPath = getConfigEnvPathInfo().resolvedPath;
  if (envPath) {
    loadEnvFile(envPath);
  }

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowedUserIds = parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS"));
  const piProfile = resolvePiAgentProfile();
  loadRequiredProfileEnv(piProfile);
  const workspace = resolveWorkspace(piProfile);
  const piSessionPath = optionalString(process.env.PI_SESSION_PATH);
  const piSessionDir = resolveOptionalPath(process.env.TELEPI_PI_SESSION_DIR)
    ?? resolveOptionalPath(process.env.PI_CODING_AGENT_SESSION_DIR)
    ?? piProfile?.sessionDir;
  const piModel = optionalString(process.env.PI_MODEL);
  const piTools = resolvePiTools(piProfile);
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const uploadsDir = resolveOptionalPath(process.env.TELEPI_UPLOADS_DIR) ?? getDefaultTelePiUploadsDir();
  const promptInboxDir = resolveOptionalPath(process.env.TELEPI_PROMPT_INBOX_DIR);
  const promptInboxIntervalMs = parsePromptInboxIntervalMs(optionalString(process.env.TELEPI_PROMPT_INBOX_INTERVAL_MS));

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    piProfile,
    workspace,
    piSessionPath,
    piSessionDir,
    piModel,
    piTools,
    toolVerbosity,
    uploadsDir,
    promptInboxDir,
    promptInboxIntervalMs,
  };
}

export function getConfigEnvPathInfo(): TelePiConfigPathInfo {
  const explicitPath = optionalString(process.env.TELEPI_CONFIG);
  const resolvedExplicitPath = explicitPath ? resolvePathFromCwd(explicitPath) : undefined;
  const defaultPath = getDefaultTelePiConfigPath();
  const localPath = path.resolve(process.cwd(), ".env");

  if (resolvedExplicitPath) {
    return {
      explicitPath: resolvedExplicitPath,
      defaultPath,
      localPath,
      resolvedPath: resolvedExplicitPath,
      source: "explicit",
    };
  }

  if (existsSync(localPath)) {
    return {
      defaultPath,
      localPath,
      resolvedPath: localPath,
      source: "cwd",
    };
  }

  if (existsSync(defaultPath)) {
    return {
      defaultPath,
      localPath,
      resolvedPath: defaultPath,
      source: "default",
    };
  }

  return {
    defaultPath,
    localPath,
    source: "missing",
  };
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - TELEPI_WORKSPACE when set outside Docker
 * - selected Pi agent profile workspace/defaultWorkspace
 * - Otherwise: process.cwd() (same as running Pi normally)
 */
function resolveWorkspace(piProfile: ResolvedPiAgentProfile | undefined): string {
  if (isRunningInDocker()) {
    return DOCKER_WORKSPACE_PATH;
  }

  const overriddenWorkspace = optionalString(process.env.TELEPI_WORKSPACE);
  if (overriddenWorkspace) {
    return resolvePathFromCwd(overriddenWorkspace);
  }

  if (piProfile?.workspace) {
    return piProfile.workspace;
  }

  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveOptionalPath(value: string | undefined): string | undefined {
  const normalized = optionalString(value);
  return normalized ? resolvePathFromCwd(normalized) : undefined;
}

function resolvePiTools(piProfile: ResolvedPiAgentProfile | undefined): string[] | undefined {
  const explicitTools = parsePiTools(optionalString(process.env.TELEPI_PI_TOOLS));
  if (explicitTools) {
    return explicitTools;
  }

  return piProfile?.tools ?? readPiProfileTools(resolvePiProfilePath());
}

function resolvePiProfilePath(): string | undefined {
  const explicitPath = resolveOptionalPath(process.env.TELEPI_PI_PROFILE);
  if (explicitPath) {
    return explicitPath;
  }

  const agentDir = optionalString(process.env.PI_CODING_AGENT_DIR);
  if (!agentDir) {
    return undefined;
  }

  return path.join(resolveTildePath(agentDir), "profile.json");
}

function resolvePiAgentProfile(): ResolvedPiAgentProfile | undefined {
  const profilePath = resolveSelectedProfilePath();
  if (!profilePath) {
    return undefined;
  }

  const profile = readPiAgentProfile(profilePath);
  if (!profile) {
    return undefined;
  }

  const profileDir = path.dirname(profilePath);
  const explicitAgentDir = resolveOptionalPath(process.env.TELEPI_PI_AGENT_DIR)
    ?? resolveOptionalPath(process.env.PI_CODING_AGENT_DIR);
  const manifestAgentDir = resolveProfilePathValue(profile.agentDir, profileDir);
  const agentDir = explicitAgentDir ?? manifestAgentDir ?? profileDir;
  const sessionDir = resolveProfilePathValue(profile.sessionDir, profileDir);
  const workspace = resolveProfilePathValue(profile.workspace ?? profile.defaultWorkspace, profileDir);
  const requiredEnv = Array.isArray(profile.requiredEnv) ? normalizeEnvNames(profile.requiredEnv) : undefined;
  const tools = Array.isArray(profile.tools) ? normalizeToolNames(profile.tools) : undefined;

  return {
    ...(typeof profile.id === "string" && profile.id.trim() ? { id: profile.id.trim() } : {}),
    path: profilePath,
    agentDir,
    ...(sessionDir ? { sessionDir } : {}),
    ...(workspace ? { workspace } : {}),
    ...(requiredEnv ? { requiredEnv } : {}),
    ...(tools ? { tools } : {}),
  };
}

function loadRequiredProfileEnv(piProfile: ResolvedPiAgentProfile | undefined): void {
  const requiredEnv = piProfile?.requiredEnv;
  if (!requiredEnv || requiredEnv.length === 0) {
    return;
  }

  const missing: string[] = [];
  for (const name of requiredEnv) {
    if (optionalString(process.env[name])) {
      continue;
    }

    const value = readVaultSecret(name);
    if (value) {
      process.env[name] = value;
      continue;
    }

    missing.push(name);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required Pi profile environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  }
}

function readVaultSecret(name: string): string | undefined {
  try {
    return optionalString(execFileSync("vault", ["get", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return undefined;
  }
}

function resolveSelectedProfilePath(): string | undefined {
  const selected = optionalString(process.env.TELEPI_PROFILE)
    ?? optionalString(process.env.PI_AGENT_PROFILE)
    ?? optionalString(process.env.TELEPI_PI_PROFILE);
  if (!selected) {
    return resolvePiProfilePath();
  }

  if (selected === "mark2") {
    return "/home/sahil/projects/mark-2/config/pi-agent/profile.json";
  }

  const resolved = resolveTildePath(selected);
  if (existsSync(resolved)) {
    return resolved;
  }

  throw new Error(`Unknown Pi agent profile: ${selected}`);
}

function readPiAgentProfile(profilePath: string): PiAgentProfileFile | undefined {
  if (!existsSync(profilePath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(profilePath, "utf8")) as PiAgentProfileFile;
  } catch (error) {
    console.warn(`Ignoring ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function resolveProfilePathValue(value: unknown, baseDir: string): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return resolveTildePath(trimmed);
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
}

function readPiProfileTools(profilePath: string | undefined): string[] | undefined {
  if (!profilePath || !existsSync(profilePath)) {
    return undefined;
  }

  try {
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as { tools?: unknown };
    if (profile.tools === undefined) {
      return undefined;
    }
    if (!Array.isArray(profile.tools)) {
      console.warn(`Ignoring ${profilePath}: "tools" must be an array of tool names.`);
      return undefined;
    }
    return normalizeToolNames(profile.tools);
  } catch (error) {
    console.warn(`Ignoring ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parsePromptInboxIntervalMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_PROMPT_INBOX_INTERVAL_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `Invalid TELEPI_PROMPT_INBOX_INTERVAL_MS value: "${raw}". Falling back to ${DEFAULT_PROMPT_INBOX_INTERVAL_MS}ms.`
    );
    return DEFAULT_PROMPT_INBOX_INTERVAL_MS;
  }

  if (parsed < MIN_PROMPT_INBOX_INTERVAL_MS) {
    console.warn(
      `TELEPI_PROMPT_INBOX_INTERVAL_MS is below ${MIN_PROMPT_INBOX_INTERVAL_MS}ms. Clamping to ${MIN_PROMPT_INBOX_INTERVAL_MS}ms.`
    );
    return MIN_PROMPT_INBOX_INTERVAL_MS;
  }

  return parsed;
}

export function parseAllowedUserIds(raw: string): number[] {
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid Telegram user id in TELEGRAM_ALLOWED_USER_IDS: ${value}`);
      }
      return parsed;
    });

  if (ids.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one user id");
  }

  return ids;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`
      );
      return "summary";
  }
}

function parsePiTools(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  return normalizeToolNames(raw.split(","));
}

function normalizeToolNames(values: unknown[]): string[] | undefined {
  const tools = [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return tools.length > 0 ? tools : undefined;
}

function normalizeEnvNames(values: unknown[]): string[] | undefined {
  const names = [
    ...new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    ),
  ];
  return names.length > 0 ? names : undefined;
}

function resolveTildePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return resolvePathFromCwd(value);
}
