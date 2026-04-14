#!/usr/bin/env bun
/**
 * hapihub-migrator monitor
 *
 * Periodically inspects the hapihub-migrator workload in medicard-staging,
 * classifies its overall state, and posts a short status embed to a Discord
 * channel via a webhook.
 *
 * Runs locally only. The Discord webhook URL lives in .env.local and never
 * touches the cluster or the git index.
 *
 * Usage:
 *   bun scripts/monitor-migration.ts                 # single check, post once, exit
 *   bun scripts/monitor-migration.ts --loop 5m       # run every 5 minutes, foreground loop
 *   bun scripts/monitor-migration.ts --dry-run       # print the embed to stdout, do not post
 *   bun scripts/monitor-migration.ts --namespace X   # target a different namespace
 *   bun scripts/monitor-migration.ts --since 30m     # look back this far in logs (default 10m)
 *   bun scripts/monitor-migration.ts --help
 *
 * Setup:
 *   1. Copy `.env.example` → `.env.local` (already gitignored)
 *   2. Add DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
 *   3. mise will load `.env.local` automatically via `mise run monitor-migration`
 *
 * Reference incident:
 *   reports/2026-03-12-azure-pg-recurring-readonly-storage-threshold.md
 */

import { $ } from "bun";
import { parseArgs } from "util";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import chalk from "chalk";

// ============================================================================
// Types
// ============================================================================

interface Args {
  namespace: string;
  argoApp: string;
  selector: string;
  since: string;
  loop?: string;
  dryRun: boolean;
  help: boolean;
}

interface LogLine {
  level: number;
  time: number;
  msg: string;
  [key: string]: unknown;
}

interface ProgressEvent {
  collection: string;
  table: string;
  processed: number;
  totalEstimate?: number;
  timeMs: number;
}

interface PhaseEvent {
  phase: number;
  timeMs: number;
}

interface RetryEvent {
  collection?: string;
  sqlstate: string;
  attempt?: number;
  totalAttempts?: number;
  backoffMs?: number;
  batchSize?: number;
  timeMs: number;
}

interface TerminalEvent {
  type: "complete" | "failed";
  msg: string;
  totalErrors?: number;
  err?: string;
  timeMs: number;
}

interface CompletedCollection {
  collection: string;
  table: string;
  processed: number;
}

interface ResumingCollection {
  collection: string;
  table: string;
  alreadyProcessed: number;
}

interface MigrationOverview {
  /** Collections that logged "Already completed, skipping". */
  completed: CompletedCollection[];
  /** The collection that logged "Resuming" (actively being worked on from a checkpoint). */
  resuming?: ResumingCollection;
  /** Highest phase number seen in "Starting phase N" lines. */
  maxPhase?: number;
  /** Total unique collection names seen across all phase start lists. */
  totalCollections: number;
  /** Total rows across all completed collections. */
  totalRowsCompleted: number;
}

interface LogState {
  latestProgress?: ProgressEvent;
  latestPhase?: PhaseEvent;
  latestRetry?: RetryEvent;
  latestTerminal?: TerminalEvent;
  retryCount25006: number;
  progressCount: number;
  latestLineTimeMs?: number;
  /** True if "Connected to PostgreSQL" was seen but no phase/progress lines followed. */
  inSchemaInit: boolean;
  /** True if "hapihub-migrator starting" was seen in the window. */
  startupSeen: boolean;
  /** Overall migration completion derived from startup scan logs. */
  overview: MigrationOverview;
}

interface PodInfo {
  name: string;
  phase: string;
  ready: boolean;
  restartCount: number;
  startedAt?: string;
  image: string;
  imageID: string;
  waitingReason?: string;
  lastTerminationReason?: string;
  nodeName?: string;
}

interface ArgoAppInfo {
  health: string;
  sync: string;
  revision: string;
}

type StatusKind =
  | "done"
  | "healthy"
  | "schema-init"
  | "ro-backoff"
  | "oom-checkpoint"
  | "stalled"
  | "failing"
  | "unknown";

interface Classification {
  kind: StatusKind;
  title: string;
  color: number;
  description: string;
  fields: { name: string; value: string; inline?: boolean }[];
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: string;
  footer?: { text: string };
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_COLORS: Record<StatusKind, number> = {
  done: 0x2ecc71, // green
  healthy: 0x3498db, // blue
  "schema-init": 0x9b59b6, // purple — expected, long-running, not a problem
  "ro-backoff": 0xf1c40f, // yellow
  "oom-checkpoint": 0xe67e22, // orange — expected brute-force behavior, not a failure
  stalled: 0xe67e22, // orange
  failing: 0xe74c3c, // red
  unknown: 0x95a5a6, // gray
};

const STATUS_EMOJI: Record<StatusKind, string> = {
  done: "🏁",
  healthy: "✅",
  "schema-init": "🔧",
  "ro-backoff": "⚠️",
  "oom-checkpoint": "🔄",
  stalled: "⚠️",
  failing: "🔴",
  unknown: "❔",
};

/** States that are worth paging @everyone about. Healthy/done/unknown stay quiet. */
const PROBLEM_STATES: ReadonlySet<StatusKind> = new Set<StatusKind>(["failing", "stalled", "ro-backoff"]);

const WEBHOOK_ENV = "DISCORD_WEBHOOK_URL";
const DEFAULT_LOOP_INTERVAL = "1h";

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
hapihub-migrator monitor — periodic status → Discord

Usage:
  bun scripts/monitor-migration.ts [options]
  mise run monitor-migration -- [options]

Options:
  --namespace <ns>        Target namespace (default: medicard-staging)
  --argo-app <name>       ArgoCD app name (default: medicard-staging-hapihub-migrator)
  --selector <sel>        Pod label selector (default: app.kubernetes.io/name=hapihub-migrator)
  --since <duration>      Log look-back window (default: 10m)
  --loop [duration]       Run every <duration> in the foreground (e.g. 5m, 30s, 1h).
                          Default interval if omitted: ${DEFAULT_LOOP_INTERVAL}. Ctrl-C to stop.
  --dry-run               Print the embed to stdout, do not post to Discord.
  --help, -h              Show this help.

Mentions:
  Problematic states (failing, stalled, ro-backoff) post with @everyone.
  Healthy / done / unknown post silently.

Environment:
  ${WEBHOOK_ENV}
    Discord incoming webhook URL. Put this in .env.local
    (gitignored). Required unless --dry-run.

Examples:
  mise run monitor-migration -- --dry-run
  mise run monitor-migration -- --loop 5m
  mise run monitor-migration -- --since 30m
`);
}

function parseCli(): Args {
  // Preprocess argv so `--loop` with no value (or followed by another flag)
  // gets the default interval injected. parseArgs itself does not support
  // string options with optional values.
  const rawArgs = Bun.argv.slice(2);
  const preprocessed: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]!;
    if (a === "--loop") {
      const next = rawArgs[i + 1];
      if (next === undefined || next.startsWith("--")) {
        preprocessed.push(`--loop=${DEFAULT_LOOP_INTERVAL}`);
      } else {
        preprocessed.push("--loop", next);
        i++;
      }
      continue;
    }
    preprocessed.push(a);
  }

  const { values } = parseArgs({
    args: preprocessed,
    options: {
      namespace: { type: "string", default: "medicard-staging" },
      "argo-app": { type: "string", default: "medicard-staging-hapihub-migrator" },
      selector: { type: "string", default: "app.kubernetes.io/name=hapihub-migrator" },
      since: { type: "string", default: "10m" },
      loop: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  return {
    namespace: values.namespace as string,
    argoApp: values["argo-app"] as string,
    selector: values.selector as string,
    since: values.since as string,
    loop: values.loop as string | undefined,
    dryRun: values["dry-run"] as boolean,
    help: values.help as boolean,
  };
}

// ============================================================================
// Duration parsing
// ============================================================================

/** Parse a duration like "5m", "30s", "1h" into milliseconds. */
function parseDurationMs(s: string): number {
  const m = s.trim().match(/^(\d+)\s*(ms|s|m|h)$/i);
  if (!m) throw new Error(`invalid duration: ${s} (expected e.g. 5m, 30s, 1h)`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    default:
      throw new Error(`invalid duration unit: ${unit}`);
  }
}

/** Format a duration in ms as a short human-readable string. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatProgressPct(processed: number, estimate?: number): string | undefined {
  if (!estimate || estimate <= 0) return undefined;
  const pct = (processed / estimate) * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

// ============================================================================
// Log parsing
// ============================================================================

function parseLines(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    try {
      const parsed = JSON.parse(trimmed) as LogLine;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.level === "number" &&
        typeof parsed.time === "number" &&
        typeof parsed.msg === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function extractState(lines: LogLine[]): LogState {
  const overview: MigrationOverview = {
    completed: [],
    totalCollections: 0,
    totalRowsCompleted: 0,
  };
  const allCollectionNames = new Set<string>();
  const completedNames = new Set<string>();
  let connectedSeen = false;
  let startupSeen = false;
  const state: LogState = { retryCount25006: 0, progressCount: 0, overview, inSchemaInit: false, startupSeen: false };

  for (const line of lines) {
    if (state.latestLineTimeMs === undefined || line.time > state.latestLineTimeMs) {
      state.latestLineTimeMs = line.time;
    }

    // "Already completed, skipping" — emitted at startup for each done collection
    if (
      line.msg === "Already completed, skipping" &&
      typeof line.collection === "string" &&
      typeof line.processed === "number"
    ) {
      const name = line.collection as string;
      if (!completedNames.has(name)) {
        completedNames.add(name);
        const entry: CompletedCollection = {
          collection: name,
          table: (line.table as string) ?? name,
          processed: line.processed as number,
        };
        overview.completed.push(entry);
        overview.totalRowsCompleted += entry.processed;
      }
      continue;
    }

    // "Resuming" — the collection being resumed from checkpoint
    if (
      line.msg === "Resuming" &&
      typeof line.collection === "string" &&
      typeof line.alreadyProcessed === "number"
    ) {
      overview.resuming = {
        collection: line.collection as string,
        table: (line.table as string) ?? (line.collection as string),
        alreadyProcessed: line.alreadyProcessed as number,
      };
      continue;
    }

    // "Collection migration completed" — emitted when a collection finishes in the current run
    if (
      line.msg === "Collection migration completed" &&
      typeof line.collection === "string" &&
      typeof line.processed === "number"
    ) {
      const name = line.collection as string;
      if (!completedNames.has(name)) {
        completedNames.add(name);
        const entry: CompletedCollection = {
          collection: name,
          table: (line.table as string) ?? name,
          processed: line.processed as number,
        };
        overview.completed.push(entry);
        overview.totalRowsCompleted += entry.processed;
      }
      continue;
    }

    // "Starting phase N" with a collections array — inventory for total count
    if (
      typeof line.msg === "string" &&
      line.msg.startsWith("Starting phase") &&
      typeof line.phase === "number"
    ) {
      const phase = line.phase as number;
      if (overview.maxPhase === undefined || phase > overview.maxPhase) {
        overview.maxPhase = phase;
      }
      // Collect all collection names from the phase list
      if (Array.isArray(line.collections)) {
        for (const c of line.collections as string[]) {
          if (typeof c === "string") allCollectionNames.add(c);
        }
      }

      const evt: PhaseEvent = { phase, timeMs: line.time };
      if (!state.latestPhase || evt.timeMs > state.latestPhase.timeMs) {
        state.latestPhase = evt;
      }
      continue;
    }

    // Progress lines
    if (line.msg === "Progress" && typeof line.collection === "string" && typeof line.processed === "number") {
      state.progressCount++;
      const evt: ProgressEvent = {
        collection: line.collection as string,
        table: (line.table as string) ?? (line.collection as string),
        processed: line.processed as number,
        totalEstimate: typeof line.totalEstimate === "number" ? (line.totalEstimate as number) : undefined,
        timeMs: line.time,
      };
      if (!state.latestProgress || evt.timeMs > state.latestProgress.timeMs) {
        state.latestProgress = evt;
      }
      continue;
    }

    if (line.sqlstate === "25006") {
      state.retryCount25006++;
      const evt: RetryEvent = {
        collection: typeof line.collection === "string" ? (line.collection as string) : undefined,
        sqlstate: "25006",
        attempt: typeof line.attempt === "number" ? (line.attempt as number) : undefined,
        totalAttempts: typeof line.totalAttempts === "number" ? (line.totalAttempts as number) : undefined,
        backoffMs: typeof line.backoffMs === "number" ? (line.backoffMs as number) : undefined,
        batchSize: typeof line.batchSize === "number" ? (line.batchSize as number) : undefined,
        timeMs: line.time,
      };
      if (!state.latestRetry || evt.timeMs > state.latestRetry.timeMs) {
        state.latestRetry = evt;
      }
      continue;
    }

    if (line.msg === "Bulk migration complete" || line.msg === "Phase 1 bulk migration complete") {
      const evt: TerminalEvent = {
        type: "complete",
        msg: line.msg,
        totalErrors: typeof line.totalErrors === "number" ? (line.totalErrors as number) : undefined,
        timeMs: line.time,
      };
      if (!state.latestTerminal || evt.timeMs > state.latestTerminal.timeMs) {
        state.latestTerminal = evt;
      }
      continue;
    }
    if (line.msg === "Bulk migration failed") {
      const evt: TerminalEvent = {
        type: "failed",
        msg: line.msg,
        err: typeof line.err === "string" ? (line.err as string) : undefined,
        timeMs: line.time,
      };
      if (!state.latestTerminal || evt.timeMs > state.latestTerminal.timeMs) {
        state.latestTerminal = evt;
      }
      continue;
    }

    // Startup / connection markers
    if (line.msg === "hapihub-migrator starting") {
      startupSeen = true;
      continue;
    }
    if (line.msg === "Connected to PostgreSQL") {
      connectedSeen = true;
      continue;
    }
  }

  // Also count the resuming and any actively-progressing collection in the total
  if (overview.resuming) allCollectionNames.add(overview.resuming.collection);
  for (const c of completedNames) allCollectionNames.add(c);

  overview.totalCollections = allCollectionNames.size;

  // Detect schema-init: connected to PG but no phase/progress/terminal/completed lines
  // have appeared yet — the pod is in Drizzle schema migration (creating tables/indexes).
  state.startupSeen = startupSeen;
  state.inSchemaInit = connectedSeen &&
    state.progressCount === 0 &&
    !state.latestPhase &&
    !state.latestTerminal &&
    overview.completed.length === 0 &&
    !overview.resuming;

  return state;
}

// ============================================================================
// Kubectl helpers
// ============================================================================

/**
 * Resolve kubeconfig path and context, mirroring the kubectl-access skill.
 * Honors .kube/.claude-choice.json if present, else KUBECONFIG env, else
 * .kube/config, else ~/.kube/config.
 */
function resolveKubeAccess(): { kubeconfig: string; context?: string } {
  const choicePath = join(process.cwd(), ".kube", ".claude-choice.json");
  if (existsSync(choicePath)) {
    try {
      const choice = JSON.parse(readFileSync(choicePath, "utf8")) as {
        kubeconfig?: string;
        context?: string;
      };
      if (choice.kubeconfig && existsSync(choice.kubeconfig)) {
        return { kubeconfig: choice.kubeconfig, context: choice.context };
      }
    } catch {
      // fall through
    }
  }

  const envKC = process.env.KUBECONFIG;
  if (envKC && existsSync(envKC)) return { kubeconfig: envKC };

  const localKC = join(process.cwd(), ".kube", "config");
  if (existsSync(localKC)) return { kubeconfig: localKC };

  const home = process.env.HOME || "~";
  const defaultKC = join(home, ".kube", "config");
  if (existsSync(defaultKC)) return { kubeconfig: defaultKC };

  throw new Error("no kubeconfig found (checked .kube/.claude-choice.json, $KUBECONFIG, .kube/config, ~/.kube/config)");
}

function kubectlBaseArgs(kc: { kubeconfig: string; context?: string }): string[] {
  const args = ["--kubeconfig", kc.kubeconfig];
  if (kc.context) args.push("--context", kc.context);
  return args;
}

async function kubectlJson<T = unknown>(args: string[]): Promise<T> {
  const result = await $`kubectl ${args}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`kubectl ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString()) as T;
}

async function kubectlText(args: string[]): Promise<string> {
  const result = await $`kubectl ${args}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`kubectl ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

async function fetchArgoApp(
  kc: { kubeconfig: string; context?: string },
  app: string,
): Promise<ArgoAppInfo | undefined> {
  try {
    const json = await kubectlJson<{
      status?: {
        health?: { status?: string };
        sync?: { status?: string; revision?: string };
      };
    }>([...kubectlBaseArgs(kc), "-n", "argocd", "get", "app", app, "-o", "json"]);
    return {
      health: json.status?.health?.status ?? "Unknown",
      sync: json.status?.sync?.status ?? "Unknown",
      revision: json.status?.sync?.revision ?? "",
    };
  } catch {
    return undefined;
  }
}

interface PodListItem {
  metadata?: { name?: string; deletionTimestamp?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      ready?: boolean;
      restartCount?: number;
      started?: boolean;
      state?: {
        running?: { startedAt?: string };
        waiting?: { reason?: string; message?: string };
        terminated?: { reason?: string; exitCode?: number; finishedAt?: string };
      };
      lastState?: {
        terminated?: { reason?: string; exitCode?: number; finishedAt?: string };
      };
      image?: string;
      imageID?: string;
    }>;
  };
  spec?: { nodeName?: string; containers?: Array<{ image?: string }> };
}

async function fetchMigratorPod(
  kc: { kubeconfig: string; context?: string },
  namespace: string,
  selector: string,
): Promise<PodInfo | undefined> {
  const json = await kubectlJson<{ items?: PodListItem[] }>([
    ...kubectlBaseArgs(kc),
    "-n",
    namespace,
    "get",
    "pods",
    "-l",
    selector,
    "-o",
    "json",
  ]);

  const items = json.items ?? [];
  // Prefer non-terminating pods, then most recent by startedAt.
  const live = items.filter((p) => !p.metadata?.deletionTimestamp);
  const candidates = live.length > 0 ? live : items;
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    const ta = a.status?.containerStatuses?.[0]?.state?.running?.startedAt ?? "";
    const tb = b.status?.containerStatuses?.[0]?.state?.running?.startedAt ?? "";
    return tb.localeCompare(ta);
  });

  const p = candidates[0]!;
  const cs = p.status?.containerStatuses?.[0];
  return {
    name: p.metadata?.name ?? "?",
    phase: p.status?.phase ?? "Unknown",
    ready: cs?.ready ?? false,
    restartCount: cs?.restartCount ?? 0,
    startedAt: cs?.state?.running?.startedAt,
    image: cs?.image ?? p.spec?.containers?.[0]?.image ?? "?",
    imageID: cs?.imageID ?? "",
    waitingReason: cs?.state?.waiting?.reason,
    lastTerminationReason: p.status?.containerStatuses?.[0]?.lastState?.terminated?.reason,
    nodeName: p.spec?.nodeName,
  };
}

async function fetchRecentLogs(
  kc: { kubeconfig: string; context?: string },
  namespace: string,
  podName: string,
  since: string,
): Promise<string> {
  // `--since` uses kubectl's own parser (e.g. 10m, 1h). --tail caps the volume.
  return kubectlText([
    ...kubectlBaseArgs(kc),
    "-n",
    namespace,
    "logs",
    podName,
    `--since=${since}`,
    "--tail=2000",
  ]);
}

// ============================================================================
// Classification
// ============================================================================

interface ClassifyInput {
  pod?: PodInfo;
  argo?: ArgoAppInfo;
  log: LogState;
  nowMs: number;
}

function classify(input: ClassifyInput): Classification {
  const { pod, argo, log, nowMs } = input;

  // No pod at all — either deleted or scaled to 0
  if (!pod) {
    return {
      kind: "unknown",
      title: "Medicard · hapihub-migrator — Unknown",
      color: STATUS_COLORS.unknown,
      description: "No pods found matching the selector.",
      fields: [...overallProgressField(log), ...argoFields(argo)],
    };
  }

  // CrashLoopBackOff — distinguish OOMKilled (expected checkpoint behavior) from actual failures
  if (pod.waitingReason === "CrashLoopBackOff" && pod.lastTerminationReason === "OOMKilled") {
    return {
      kind: "oom-checkpoint",
      title: "Medicard · hapihub-migrator — OOM checkpoint cycle (expected)",
      color: STATUS_COLORS["oom-checkpoint"],
      description: [
        "Pod is OOM-killed each cycle but making incremental progress via checkpointing.",
        "This is the expected brute-force behavior for the final collection (`diagnostic-order-tests-history`).",
        "No action needed — the migration will complete over repeated restart cycles.",
      ].join("\n"),
      fields: [
        ...overallProgressField(log),
        { name: "Pod", value: `${pod.name}\nOOMKilled, restarts: ${pod.restartCount}`, inline: false },
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // CrashLoopBackOff or similar waiting reason (non-OOM) = actually failing
  if (pod.waitingReason === "CrashLoopBackOff" || pod.waitingReason === "ImagePullBackOff" || pod.waitingReason === "ErrImagePull") {
    return {
      kind: "failing",
      title: `Medicard · hapihub-migrator — Failing (${pod.waitingReason})`,
      color: STATUS_COLORS.failing,
      description: describeFailure(pod, log),
      fields: [
        ...overallProgressField(log),
        { name: "Pod", value: `${pod.name}\n${pod.waitingReason}, restarts: ${pod.restartCount}`, inline: false },
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // Terminal failed event in the log window
  if (log.latestTerminal?.type === "failed") {
    return {
      kind: "failing",
      title: "Medicard · hapihub-migrator — Failing",
      color: STATUS_COLORS.failing,
      description: `Terminal error in logs:\n\`${log.latestTerminal.err ?? log.latestTerminal.msg}\``,
      fields: [
        ...overallProgressField(log),
        { name: "Pod", value: `${pod.name}\nrestarts: ${pod.restartCount}`, inline: false },
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // Terminal complete event in the log window
  if (log.latestTerminal?.type === "complete") {
    const errs = log.latestTerminal.totalErrors;
    const ok = errs === undefined || errs === 0;
    return {
      kind: "done",
      title: ok ? "Medicard · hapihub-migrator — Complete" : `Medicard · hapihub-migrator — Complete (${errs} errors)`,
      color: STATUS_COLORS.done,
      description: ok
        ? "Bulk migration reported complete with no errors."
        : `Bulk migration reported complete with ${errs} errors.`,
      fields: [
        ...overallProgressField(log),
        ...etaField(log, nowMs, pod),
        ...progressFields(log, nowMs),
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // Pod not Ready (but no known CrashLoop) — ambiguous, flag as unknown
  if (!pod.ready) {
    return {
      kind: "unknown",
      title: `Medicard · hapihub-migrator — Pod not ready (${pod.waitingReason ?? pod.phase})`,
      color: STATUS_COLORS.unknown,
      description: `Pod \`${pod.name}\` is not Ready.`,
      fields: [...overallProgressField(log), ...argoFields(argo), ...imageField(pod)],
    };
  }

  // Retry-dominated window = PG read-only backoff
  if (log.retryCount25006 > 0 && log.retryCount25006 >= log.progressCount) {
    return {
      kind: "ro-backoff",
      title: "Medicard · hapihub-migrator — Degraded (PG read-only backoff)",
      color: STATUS_COLORS["ro-backoff"],
      description: [
        "Target Postgres is refusing writes (`sqlstate=25006`). Migrator is retrying with backoff.",
        "See `reports/2026-03-12-azure-pg-recurring-readonly-storage-threshold.md` — this is the recurring incident.",
      ].join("\n"),
      fields: [
        ...overallProgressField(log),
        ...etaField(log, nowMs, pod),
        {
          name: "Retry state",
          value: [
            `25006 errors (last window): **${log.retryCount25006}**`,
            log.latestRetry?.attempt !== undefined
              ? `Latest retry: attempt ${log.latestRetry.attempt}/${log.latestRetry.totalAttempts ?? "?"} @ batch ${log.latestRetry.batchSize ?? "?"}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          inline: false,
        },
        ...progressFields(log, nowMs),
        ...podFields(pod, nowMs),
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // Schema init — pod connected to PG but no migration work has started yet.
  // Drizzle is applying schema migrations (CREATE TABLE, CREATE INDEX, etc.).
  // This can take hours for GIN indexes on large tables like activity_logs.
  if (log.inSchemaInit && pod.ready) {
    const startedAt = pod.startedAt ? new Date(pod.startedAt).getTime() : undefined;
    const initDuration = startedAt ? formatDurationMs(Math.max(0, nowMs - startedAt)) : "?";
    return {
      kind: "schema-init",
      title: "Medicard · hapihub-migrator — Schema init (building indexes)",
      color: STATUS_COLORS["schema-init"],
      description: [
        "Drizzle is applying schema migrations (creating tables/indexes).",
        `Running for **${initDuration}**. GIN indexes on large tables (activity_logs: 84M+ rows, 1TB+) can take several hours.`,
        "This is expected. Pod is healthy, no action needed.",
      ].join("\n"),
      fields: [
        ...overallProgressField(log),
        ...etaField(log, nowMs, pod),
        ...podFields(pod, nowMs),
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // Pod ready but no recent progress and no retries = stalled
  const lastProgressAgeMs = log.latestProgress ? nowMs - log.latestProgress.timeMs : Infinity;
  if (log.progressCount === 0 || lastProgressAgeMs > 10 * 60 * 1000) {
    return {
      kind: "stalled",
      title: "Medicard · hapihub-migrator — Stalled (no recent progress)",
      color: STATUS_COLORS.stalled,
      description: log.latestProgress
        ? `No \`Progress\` lines for ${formatDurationMs(lastProgressAgeMs)}.`
        : `No \`Progress\` lines in the last window.`,
      fields: [
        ...overallProgressField(log),
        ...etaField(log, nowMs, pod),
        ...progressFields(log, nowMs),
        ...podFields(pod, nowMs),
        ...argoFields(argo),
        ...imageField(pod),
      ],
    };
  }

  // Default healthy path
  return {
    kind: "healthy",
    title: "Medicard · hapihub-migrator — Healthy",
    color: STATUS_COLORS.healthy,
    description: log.latestPhase
      ? `Phase ${log.latestPhase.phase} in progress.`
      : "Migration in progress.",
    fields: [
      ...overallProgressField(log),
      ...etaField(log, nowMs, pod),
      ...progressFields(log, nowMs),
      ...podFields(pod, nowMs),
      ...argoFields(argo),
      ...imageField(pod),
    ],
  };
}

function describeFailure(pod: PodInfo, log: LogState): string {
  if (log.latestTerminal?.type === "failed") {
    return `Pod is in ${pod.waitingReason}, and logs show: \`${log.latestTerminal.err ?? log.latestTerminal.msg}\``;
  }
  return `Pod is in ${pod.waitingReason} with ${pod.restartCount} restarts.`;
}

function etaField(log: LogState, nowMs: number, pod?: PodInfo): { name: string; value: string; inline?: boolean }[] {
  const ov = log.overview;

  // Schema init — ETA is unpredictable (depends on index build I/O)
  if (log.inSchemaInit) {
    const startedAt = pod?.startedAt ? new Date(pod.startedAt).getTime() : undefined;
    const elapsed = startedAt ? formatDurationMs(Math.max(0, nowMs - startedAt)) : "?";
    return [{
      name: "⏱ ETA",
      value: `Pending index creation (elapsed: ${elapsed})\nGIN indexes on TB-scale tables are I/O-bound and unpredictable.\nData migration starts after schema init completes.`,
      inline: false,
    }];
  }

  // Done
  if (log.latestTerminal?.type === "complete") {
    return [{ name: "⏱ ETA", value: "**Complete!**", inline: false }];
  }

  // If we have progress data on the current collection, compute rate-based ETA
  if (log.latestProgress && log.latestProgress.totalEstimate && log.progressCount >= 2) {
    const p = log.latestProgress;
    const remaining = Math.max(0, (p.totalEstimate ?? 0) - p.processed);

    // Estimate rate from pod uptime and processed count for the current collection
    // (rough but useful — we don't have per-window rate tracking without state)
    const startedAt = pod?.startedAt ? new Date(pod.startedAt).getTime() : undefined;
    if (startedAt && p.processed > 0) {
      const elapsedSec = Math.max(1, (nowMs - startedAt) / 1000);
      // This is total processed / total time — crude but consistent
      const rowsPerSec = p.processed / elapsedSec;
      if (rowsPerSec > 0) {
        const etaSec = remaining / rowsPerSec;
        const etaStr = formatDurationMs(etaSec * 1000);
        return [{
          name: "⏱ ETA",
          value: `~**${etaStr}** remaining (${formatInt(remaining)} rows @ ~${formatInt(Math.round(rowsPerSec))} rows/sec)`,
          inline: false,
        }];
      }
    }

    // Fallback: just show remaining rows
    return [{
      name: "⏱ ETA",
      value: `${formatInt(remaining)} rows remaining on \`${p.collection}\``,
      inline: false,
    }];
  }

  // Resuming from checkpoint — show remaining from overview
  if (ov.resuming) {
    // We don't know the total for this collection from the logs alone.
    // Show what we know.
    return [{
      name: "⏱ ETA",
      value: `Resuming \`${ov.resuming.collection}\` from ${formatInt(ov.resuming.alreadyProcessed)} rows`,
      inline: false,
    }];
  }

  return [];
}

function progressFields(log: LogState, nowMs: number): { name: string; value: string; inline?: boolean }[] {
  if (!log.latestProgress) {
    return [{ name: "Progress", value: "_no progress lines in window_", inline: false }];
  }
  const p = log.latestProgress;
  const pct = formatProgressPct(p.processed, p.totalEstimate);
  const age = formatDurationMs(Math.max(0, nowMs - p.timeMs));
  const line1 = `**${p.collection}** → \`${p.table}\``;
  const line2 =
    p.totalEstimate !== undefined
      ? `${formatInt(p.processed)} / ${formatInt(p.totalEstimate)}${pct ? ` (${pct})` : ""}`
      : `${formatInt(p.processed)} rows`;
  const line3 = `last progress: ${age} ago`;
  const phase = log.latestPhase ? ` · phase ${log.latestPhase.phase}` : "";
  return [{ name: `Progress${phase}`, value: `${line1}\n${line2}\n${line3}`, inline: false }];
}

function podFields(pod: PodInfo, nowMs: number): { name: string; value: string; inline?: boolean }[] {
  const startedAt = pod.startedAt ? new Date(pod.startedAt).getTime() : undefined;
  const uptime = startedAt ? formatDurationMs(Math.max(0, nowMs - startedAt)) : "?";
  return [
    {
      name: "Pod",
      value: `\`${pod.name}\`\nready: ${pod.ready} · restarts: ${pod.restartCount} · up ${uptime}${pod.nodeName ? `\nnode: ${pod.nodeName}` : ""}`,
      inline: false,
    },
  ];
}

function overallProgressField(log: LogState): { name: string; value: string; inline?: boolean }[] {
  const ov = log.overview;
  const completed = ov.completed.length;
  const total = ov.totalCollections;

  if (completed === 0 && !ov.resuming && total === 0) {
    return []; // no overview data available
  }

  const lines: string[] = [];

  // Collections progress bar
  const inProgress = ov.resuming ? 1 : (log.latestProgress ? 1 : 0);
  const done = completed;
  const denominator = total > 0 ? total : done + inProgress;
  if (denominator > 0) {
    const pct = Math.min(100, ((done / denominator) * 100));
    const bar = progressBar(pct, 20);
    lines.push(`${bar}  **${done}/${denominator}** collections (${pct.toFixed(0)}%)`);
  }

  // Phase info
  if (ov.maxPhase !== undefined) {
    lines.push(`Phase **${ov.maxPhase}**/5`);
  }

  // Total rows completed
  if (ov.totalRowsCompleted > 0) {
    lines.push(`${formatInt(ov.totalRowsCompleted)} rows migrated`);
  }

  // Currently working on
  if (ov.resuming) {
    lines.push(`Working on: **${ov.resuming.collection}** (resuming from ${formatInt(ov.resuming.alreadyProcessed)} rows)`);
  } else if (log.latestProgress) {
    const p = log.latestProgress;
    const pct = formatProgressPct(p.processed, p.totalEstimate);
    lines.push(
      `Working on: **${p.collection}**${pct ? ` (${pct})` : ` (${formatInt(p.processed)} rows)`}`,
    );
  }

  if (lines.length === 0) return [];

  return [{ name: "Migration overall", value: lines.join("\n"), inline: false }];
}

/** Render a simple text progress bar: [████████░░░░] */
function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return `\`[${"█".repeat(filled)}${"░".repeat(empty)}]\``;
}

function argoFields(argo?: ArgoAppInfo): { name: string; value: string; inline?: boolean }[] {
  if (!argo) return [];
  return [
    {
      name: "ArgoCD",
      value: `health: ${argo.health} · sync: ${argo.sync}${argo.revision ? `\nrev: \`${argo.revision.slice(0, 7)}\`` : ""}`,
      inline: true,
    },
  ];
}

function imageField(pod: PodInfo): { name: string; value: string; inline?: boolean }[] {
  const digest = pod.imageID.split("@")[1]; // e.g. sha256:4ecb7b…
  const short = digest ? digest.replace("sha256:", "").slice(0, 12) : "";
  return [
    {
      name: "Image",
      value: `\`${pod.image}\`${short ? `\n\`@${short}\`` : ""}`,
      inline: true,
    },
  ];
}

// ============================================================================
// Discord
// ============================================================================

function redactWebhook(url: string): string {
  return url.replace(/\/webhooks\/\d+\/[^\/\s]+/, "/webhooks/<redacted>");
}

interface DiscordPayload {
  embed: DiscordEmbed;
  /** If true, the message includes `@everyone` as content with allowed_mentions. */
  mentionEveryone?: boolean;
}

async function postEmbed(webhookUrl: string, payload: DiscordPayload): Promise<void> {
  const body: Record<string, unknown> = { embeds: [payload.embed] };
  if (payload.mentionEveryone) {
    body.content = "@everyone";
    body.allowed_mentions = { parse: ["everyone"] };
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Discord POST failed: ${res.status} ${res.statusText} ${errBody} (url: ${redactWebhook(webhookUrl)})`);
  }
}

// ============================================================================
// Safety: tripwire for accidentally-committed webhook URLs
// ============================================================================

async function tripwireCheck(webhookUrl: string): Promise<void> {
  if (!webhookUrl) return;
  try {
    const result = await $`git grep -F -l ${webhookUrl}`.quiet().nothrow();
    if (result.exitCode === 0 && result.stdout.toString().trim().length > 0) {
      const files = result.stdout.toString().trim();
      throw new Error(
        `SAFETY ABORT: the Discord webhook URL appears in tracked files:\n${files}\n\nRemove it before running the monitor. The URL belongs in .env.local only.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("SAFETY ABORT")) throw err;
    // git not available or not a repo — skip tripwire, don't fail the run
  }
}

// ============================================================================
// Main check
// ============================================================================

async function runOnce(args: Args, webhookUrl: string | undefined): Promise<void> {
  const kc = resolveKubeAccess();
  const nowMs = Date.now();

  // Gather observations
  const [argo, pod] = await Promise.all([
    fetchArgoApp(kc, args.argoApp),
    fetchMigratorPod(kc, args.namespace, args.selector),
  ]);

  const emptyOverview: MigrationOverview = { completed: [], totalCollections: 0, totalRowsCompleted: 0 };
  let log: LogState = { retryCount25006: 0, progressCount: 0, overview: emptyOverview };
  if (pod) {
    try {
      // Fetch two log slices:
      // 1. Recent activity (--since window) for progress/retry/terminal classification
      // 2. Full startup scan (--tail=2000, no --since) for overall migration completion
      //    The migrator logs "Already completed, skipping" for every finished collection
      //    on each restart, so the latest startup scan is always in the tail.
      const [recentRaw, startupRaw] = await Promise.all([
        fetchRecentLogs(kc, args.namespace, pod.name, args.since),
        kubectlText([
          ...kubectlBaseArgs(kc), "-n", args.namespace,
          "logs", pod.name, "--tail=2000",
        ]),
      ]);

      // Parse both, then merge: use the startup scan for the overview,
      // the recent window for everything else.
      const startupState = extractState(parseLines(startupRaw));
      const recentState = extractState(parseLines(recentRaw));

      log = {
        ...recentState,
        overview: startupState.overview, // startup scan has the full completion picture
        // Schema-init is true if EITHER fetch detected it AND neither has progress.
        // The startup fetch captures the "Connected to PostgreSQL" line even if it's
        // outside the --since window; the recent fetch confirms no progress has started.
        inSchemaInit: (startupState.inSchemaInit || recentState.inSchemaInit) &&
          recentState.progressCount === 0 &&
          !recentState.latestPhase &&
          !recentState.latestTerminal,
      };

      // If the recent window also found overview data (e.g. pod just restarted),
      // prefer whichever has more completed collections.
      if (recentState.overview.completed.length > startupState.overview.completed.length) {
        log.overview = recentState.overview;
      }
    } catch (err) {
      // Logs failing is not fatal — classify without them.
      console.error(chalk.yellow(`warning: failed to fetch logs for ${pod.name}: ${err instanceof Error ? err.message : err}`));
    }
  }

  const cls = classify({ pod, argo, log, nowMs });

  const embed: DiscordEmbed = {
    title: `${STATUS_EMOJI[cls.kind]} ${cls.title}`,
    description: cls.description,
    color: cls.color,
    fields: cls.fields,
    timestamp: new Date(nowMs).toISOString(),
    footer: { text: `Medicard migration · namespace: ${args.namespace} · window: ${args.since}` },
  };

  // Terminal preview
  console.log(
    chalk.bold(
      `[${new Date(nowMs).toISOString()}] ${STATUS_EMOJI[cls.kind]} ${cls.title}`,
    ),
  );
  if (cls.description) console.log(cls.description);
  for (const f of cls.fields) {
    console.log(chalk.gray(`  ${f.name}: ${f.value.replace(/\n/g, " | ")}`));
  }

  const mentionEveryone = PROBLEM_STATES.has(cls.kind);

  if (args.dryRun) {
    console.log(
      chalk.gray(
        `\n--dry-run: embed not posted${mentionEveryone ? " (would have mentioned @everyone)" : ""}`,
      ),
    );
    return;
  }

  if (!webhookUrl) {
    throw new Error(
      `${WEBHOOK_ENV} is not set. Add it to .env.local (see .env.example). Or run with --dry-run.`,
    );
  }

  await postEmbed(webhookUrl, { embed, mentionEveryone });
  console.log(chalk.gray(`posted to Discord${mentionEveryone ? " (tagged @everyone)" : ""}`));
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<void> {
  const args = parseCli();
  if (args.help) {
    printHelp();
    return;
  }

  const webhookUrl = process.env[WEBHOOK_ENV];

  if (!args.dryRun) {
    if (!webhookUrl) {
      console.error(
        chalk.red(`error: ${WEBHOOK_ENV} is not set.`) +
          `\n       Add it to .env.local (see .env.example).` +
          `\n       Or pass --dry-run to preview without posting.`,
      );
      process.exit(2);
    }
    await tripwireCheck(webhookUrl);
  }

  if (!args.loop) {
    await runOnce(args, webhookUrl);
    return;
  }

  const intervalMs = parseDurationMs(args.loop);
  console.log(chalk.gray(`loop mode: every ${formatDurationMs(intervalMs)} (Ctrl-C to stop)`));

  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(chalk.gray("\nstopping…"));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (!stopping) {
    try {
      await runOnce(args, webhookUrl);
    } catch (err) {
      console.error(chalk.red(`check failed: ${err instanceof Error ? err.message : err}`));
    }
    if (stopping) break;
    // Interruptible sleep
    const deadline = Date.now() + intervalMs;
    while (!stopping && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(500, deadline - Date.now())));
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`fatal: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
