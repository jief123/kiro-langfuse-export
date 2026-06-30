#!/usr/bin/env node
/**
 * Export a Kiro IDE (kiro-agent) session to Langfuse, one trace per TURN.
 *
 * Source: ~/.kiro/sessions/<workspaceHash>/<session_id>/
 *   - session.json   : { id, title, workspacePaths, modelId, createdAt, agentMode, status }
 *   - messages.jsonl : one {id, timestamp, payload} per line
 *
 * A turn = a `user` message (no executionId) immediately followed by
 * `turn_start`..`turn_end` (all sharing one executionId). Inside a turn:
 * assistant Reasoning/Say, tool_call/tool_result (paired by toolCallId).
 *
 * Langfuse mapping (idiomatic: session=conversation, trace=turn):
 *   - sessionId          = kiro session_id
 *   - one trace per turn = session_id::executionId  (idempotent upsert)
 *   - generation per Say/Reasoning, span per tool call
 *   - input/output use chat format [{role,content}] so the UI renders a chat
 *
 * Incremental: a per-session state file records how many turns were exported;
 * each run pushes only new turns (plus re-pushes the last one to absorb
 * write-flush lag). Designed to run from a `Stop` command hook (per turn).
 *
 * Usage:
 *   npx kiro-langfuse-export --list          # list local Kiro sessions
 *   npx kiro-langfuse-export --session <id> [--all] [--dry-run]
 *   echo '{"session_id":"sess_..."}' | npx kiro-langfuse-export   # how the Stop hook calls it
 *
 * State (incremental progress) lives in ~/.kiro/langfuse-export-state by
 * default; override with KIRO_LANGFUSE_STATE_DIR.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import dotenv from "dotenv";

const __dir = dirname(fileURLToPath(import.meta.url));
// Load .env: prefer one beside this script (standalone repo), then a parent
// directory (legacy in-workspace layout), then the current working directory.
// dotenv does not override already-set vars, so the first match wins.
dotenv.config({ path: resolve(__dir, ".env") });
dotenv.config({ path: resolve(__dir, "..", ".env") });
dotenv.config();

const SESSIONS = resolve(homedir(), ".kiro/sessions");
// State must live in a stable location. When run via `npx`, the package dir is
// an ephemeral cache, so a script-relative path would lose incremental progress
// between runs. Default to the user's home; allow override via env var.
const STATE_DIR = process.env.KIRO_LANGFUSE_STATE_DIR
  ? resolve(process.env.KIRO_LANGFUSE_STATE_DIR)
  : resolve(homedir(), ".kiro", "langfuse-export-state");

function parseArgs(argv) {
  const a = { session: null, all: false, dryRun: false, list: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--session") a.session = argv[++i];
    else if (k === "--all") a.all = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--list") a.list = true;
  }
  return a;
}

function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res({});
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => { try { res(d.trim() ? JSON.parse(d) : {}); } catch { res({}); } });
    const t = setTimeout(() => res({}), 400);
    if (t.unref) t.unref();
  });
}

function findSessionDir(sessionId) {
  if (!existsSync(SESSIONS)) return null;
  for (const ws of readdirSync(SESSIONS)) {
    const cand = join(SESSIONS, ws, sessionId);
    if (existsSync(join(cand, "messages.jsonl"))) return cand;
  }
  return null;
}

function loadSession(dir) {
  const meta = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  const messages = readFileSync(join(dir, "messages.jsonl"), "utf8")
    .split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { meta, messages };
}

/** Group messages into turns. Each turn carries its user prompt + items. */
function parseTurns(messages) {
  const turns = [];
  let pendingUser = null;
  let cur = null;
  for (const m of messages) {
    const p = m.payload || {};
    if (p.type === "user") { pendingUser = { content: p.content, id: m.id, ts: m.timestamp }; continue; }
    if (p.type === "turn_start") {
      cur = { ex: p.executionId, startTs: m.timestamp, endTs: null, stopReason: null, user: pendingUser, items: [] };
      pendingUser = null;
      turns.push(cur);
      continue;
    }
    if (p.type === "turn_end") { if (cur && cur.ex === p.executionId) { cur.endTs = m.timestamp; cur.stopReason = p.stopReason; } continue; }
    if (cur && p.executionId && p.executionId === cur.ex) cur.items.push(m);
  }
  return turns;
}

function readState(sessionId) {
  const f = join(STATE_DIR, `${sessionId}.json`);
  if (!existsSync(f)) return { turnsDone: 0 };
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return { turnsDone: 0 }; }
}

function writeState(sessionId, state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
}

export { parseArgs, readStdin, findSessionDir, loadSession, parseTurns, readState, writeState, SESSIONS, STATE_DIR };

// ---------------------------------------------------------------------------
// Build per-turn traces + main
// ---------------------------------------------------------------------------

const asText = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const toDate = (v) => { const d = new Date(v); return isNaN(d.getTime()) ? undefined : d; };
const clip = (s, n = 60) => asText(s).replace(/\s+/g, " ").slice(0, n);
const turnCredits = (turn) => {
  const u = turn.items.find((m) => m.payload?.type === "usage_summary")?.payload;
  return (u?.promptTurnSummaries || []).reduce((a, x) => a + (typeof x.usage === "number" ? x.usage : 0), 0);
};

function listSessions(limit = 25) {
  const rows = [];
  if (!existsSync(SESSIONS)) return rows;
  for (const ws of readdirSync(SESSIONS)) {
    let kids; try { kids = readdirSync(join(SESSIONS, ws)); } catch { continue; }
    for (const id of kids) {
      const sj = join(SESSIONS, ws, id, "session.json");
      if (existsSync(sj)) {
        try { const m = JSON.parse(readFileSync(sj, "utf8")); rows.push({ id: m.id || id, title: m.title, modelId: m.modelId, mtime: statSync(sj).mtimeMs }); } catch {}
      }
    }
  }
  return rows.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** Push one turn as its own Langfuse trace. */
function pushTurn(lf, meta, turn, idx, wsFolder, model) {
  const prompt = turn.user?.content;
  const results = new Map();
  let usage = null;
  for (const m of turn.items) {
    const p = m.payload || {};
    if (p.type === "tool_result" && p.toolCallId) results.set(p.toolCallId, { content: p.content, success: p.success, ts: m.timestamp });
    else if (p.type === "usage_summary") usage = p;
  }
  const says = turn.items.filter((m) => m.payload?.type === "assistant" && m.payload?.operationType === "Say");
  const lastSay = says.length ? says[says.length - 1].payload.content : null;

  // Per-turn credit usage: Kiro logs one `usage_summary` per executionId with
  // `promptTurnSummaries[].usage` in credits, plus the tools used and elapsed
  // time. Surface it as trace metadata + a numeric score so it's queryable.
  const summaries = usage?.promptTurnSummaries || [];
  const haveUsage = summaries.length > 0;
  const credits = summaries.reduce((s, x) => s + (typeof x.usage === "number" ? x.usage : 0), 0);
  const usedToolsCount = summaries.reduce((n, x) => n + (x.usedTools?.length || 0), 0);
  const creditUnit = summaries[0]?.unitPlural || summaries[0]?.unit || "credits";
  const elapsedMs = typeof usage?.elapsedTime === "number" ? usage.elapsedTime : undefined;

  const trace = lf.trace({
    id: turn.ex || `${meta.id}_t${idx}`,
    name: clip(prompt || `turn ${idx + 1}`),
    sessionId: meta.id,
    input: prompt != null ? [{ role: "user", content: asText(prompt) }] : undefined,
    output: lastSay != null ? { role: "assistant", content: asText(lastSay) } : undefined,
    timestamp: toDate(turn.startTs),
    tags: ["kiro", "session-export", String(model).toLowerCase(), meta.agentMode].filter(Boolean),
    metadata: { executionId: turn.ex, model, workspace: wsFolder, stopReason: turn.stopReason, turnIndex: idx, workspacePaths: meta.workspacePaths, aborted: !lastSay, credits: haveUsage ? credits : undefined, creditUnit: haveUsage ? creditUnit : undefined, elapsedTimeMs: elapsedMs, usedToolsCount: haveUsage ? usedToolsCount : undefined },
  });

  // Numeric score so per-turn credits can be sorted, aggregated, and charted in
  // Langfuse (not just read from metadata). Stable id keeps re-pushes idempotent.
  if (haveUsage) trace.score({ id: `${turn.ex || `${meta.id}_t${idx}`}-credits`, name: "credits", value: credits, comment: `${usedToolsCount} tool calls, ${elapsedMs ?? "?"}ms, status=${usage.status || "?"}` });

  // Kiro logs one timestamp per message (the completion time), and tool_call
  // shares its timestamp with its tool_result. True per-step latency is not in
  // the data, so we derive each observation's [start,end] as
  // [previous step's logged time, this step's logged time]: ordering is exact
  // and duration approximates the real wall-clock gap. We must NOT call
  // span.end()/generation.end() — in this SDK .end() overwrites endTime with
  // Date.now(), which is what collapsed every tool to the export instant.
  let gens = 0, tools = 0, firstGen = true;
  let prevTs = toDate(turn.startTs) || toDate(turn.items[0]?.timestamp);
  for (const m of turn.items) {
    const p = m.payload || {};
    const own = toDate(m.timestamp) || prevTs;
    const start = prevTs || own;
    if (p.type === "assistant" && p.operationType === "Say") {
      trace.generation({ id: m.id, name: "assistant", model, input: firstGen && prompt != null ? [{ role: "user", content: asText(prompt) }] : undefined, output: { role: "assistant", content: asText(p.content) }, startTime: start, endTime: own, metadata: { operationType: "Say", executionId: turn.ex } });
      gens++; firstGen = false; prevTs = own;
    } else if (p.type === "assistant" && p.operationType === "Reasoning") {
      trace.generation({ id: m.id, name: "reasoning", model, output: asText(p.content), level: "DEBUG", startTime: start, endTime: own, metadata: { operationType: "Reasoning" } });
      gens++; prevTs = own;
    } else if (p.type === "tool_call") {
      const r = results.get(p.toolCallId);
      const end = (r ? toDate(r.ts) : own) || own;
      trace.span({ id: p.toolCallId || m.id, name: `tool: ${p.toolName || "unknown"}`, input: p.args, output: r ? r.content : undefined, startTime: start, endTime: end, metadata: { toolCallId: p.toolCallId, success: r?.success, status: p.status, note: "start=prev-step time, end=tool_result time (derived; Kiro logs no separate tool-start)" } });
      tools++; prevTs = end;
    }
  }
  return { gens, tools, credits: haveUsage ? credits : 0 };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.list) { for (const s of listSessions()) console.log(`${s.id}  [${s.modelId || "?"}]  ${s.title || ""}`); return; }

  let sessionId = args.session || (await readStdin()).session_id;
  if (!sessionId) {
    // Stop-hook stdin may not carry a session id; fall back to the most
    // recently updated session (the one that just stopped).
    const latest = listSessions(1)[0];
    if (latest) { sessionId = latest.id; console.log(`no session id provided; using latest session ${sessionId}`); }
  }
  if (!sessionId) { console.error("no session id (pass --session, pipe Stop hook JSON, or have at least one Kiro session)"); process.exit(1); }
  const dir = findSessionDir(sessionId);
  if (!dir) { console.error("session not found:", sessionId); process.exit(1); }

  const { meta, messages } = loadSession(dir);
  const turns = parseTurns(messages);
  const wsFolder = basename(String((meta.workspacePaths || [])[0] || "default").replace(/[/\\]+$/, ""));
  const model = meta.modelId || "kiro-agent";
  const completed = turns.filter((t) => t.endTs).length;

  const state = args.all ? { turnsDone: 0 } : readState(sessionId);
  const start = Math.max(0, state.turnsDone - 1); // re-push last to absorb flush lag
  const toPush = turns.slice(start);
  console.log(`session ${meta.id} "${meta.title || ""}" turns=${turns.length} (completed=${completed}) exporting ${toPush.length} from #${start + 1}`);

  if (args.dryRun) { toPush.forEach((t, i) => console.log(`  turn#${start + i + 1} ex=${(t.ex || "").slice(0, 8)} user="${clip(t.user?.content, 50)}" says=${t.items.filter((m) => m.payload?.type === "assistant" && m.payload?.operationType === "Say").length} tools=${t.items.filter((m) => m.payload?.type === "tool_call").length} credits=${turnCredits(t).toFixed(2)} ${t.endTs ? "" : "[in-progress]"}`)); return; }

  const { Langfuse } = await import("langfuse");
  const lf = new Langfuse({ secretKey: process.env.LANGFUSE_SECRET_KEY, publicKey: process.env.LANGFUSE_PUBLIC_KEY, baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com" });
  let g = 0, t = 0, c = 0;
  toPush.forEach((turn, i) => { const r = pushTurn(lf, meta, turn, start + i, wsFolder, model); g += r.gens; t += r.tools; c += r.credits; });
  await lf.flushAsync();
  if (!args.all) writeState(sessionId, { turnsDone: completed });
  console.log(`pushed ${toPush.length} turn-traces (${g} generations, ${t} tool spans, ${c.toFixed(2)} credits) -> ${process.env.LANGFUSE_BASE_URL}`);
}

// Run main() only when executed as a script (not when imported). Compare REAL
// paths: when invoked via the npm `bin` symlink (npx, installed CLI, the Stop
// hook), process.argv[1] is the symlink while import.meta.url is the resolved
// file, so a naive equality check is always false and main() would never run.
const __self = fileURLToPath(import.meta.url);
let isDirectRun = false;
try { isDirectRun = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(__self); } catch { isDirectRun = false; }
if (isDirectRun) main().catch((e) => { console.error("export-session failed:", e); process.exit(1); });
