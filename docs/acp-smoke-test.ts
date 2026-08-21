#!/usr/bin/env bun
// ACP v1 smoke test for the OMP Zed external agent.
//
// Spawns `omp acp` and drives two newline-delimited JSON-RPC 2.0 round-trips
// over the subprocess stdin/stdout:
//   1. `initialize` — the mandatory ACP v1 handshake (negotiate protocolVersion).
//   2. `_ping`      — a custom liveness probe (ACP extensibility: custom
//                     methods use a leading `_`), expecting a `"pong"` result.
//
// ACP v1 has no built-in `ping` method; `_ping`/`pong` is an OMP-side contract
// defined for this smoke test. The `initialize` handshake is the mandatory part.
//
// Standalone: no package imports. Run with `bun docs/acp-smoke-test.ts`.
// Env overrides: OMP_BIN (default `omp`), ACP_SMOKE_TIMEOUT_MS (default 5000).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const OMP_BIN = process.env.OMP_BIN ?? "omp";
const ACP_ARGS = ["acp"];
const TIMEOUT_MS = Number(process.env.ACP_SMOKE_TIMEOUT_MS ?? 5000);

type JsonRpcMessage = {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

function fail(msg: string): never {
  console.error(`smoke: FAIL — ${msg}`);
  process.exit(1);
}

const initialize: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: {
      name: "zomp-acp-smoke",
      title: "Zomp ACP Smoke Test",
      version: "0.1.0",
    },
  },
};

const ping: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "_ping",
  params: {},
};

let nonJsonStdoutLines = 0;

const child = spawn(OMP_BIN, ACP_ARGS, {
  stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
});

child.stderr.pipe(process.stderr);

child.on("error", (err: { code?: string; message: string }) => {
  if (err.code === "ENOENT") {
    fail(
      `command '${OMP_BIN}' not found on PATH — expected 'omp acp' to implement ACP v1 over stdio`,
    );
  }
  fail(`failed to spawn '${OMP_BIN} ${ACP_ARGS.join(" ")}': ${err.message}`);
});

let exited = false;
let exitCode: number | null = null;
child.on("exit", (code) => {
  exited = true;
  exitCode = code;
});

function notAnAcpServerHint(): string {
  if (nonJsonStdoutLines === 0) return "";
  return ` (received ${nonJsonStdoutLines} non-JSON stdout lines — is 'omp acp' an ACP server?)`;
}

const timer = setTimeout(() => {
  child.kill("SIGTERM");
  fail(`timed out after ${TIMEOUT_MS}ms waiting for an ACP response${notAnAcpServerHint()}`);
}, TIMEOUT_MS);

const lines = createInterface({ input: child.stdout });
const pending = new Map<number, (msg: JsonRpcMessage) => void>();

function send(frame: JsonRpcMessage): void {
  child.stdin.write(JSON.stringify(frame) + "\n");
}

function request(frame: JsonRpcMessage): Promise<JsonRpcMessage> {
  const id = frame.id as number;
  return new Promise<JsonRpcMessage>((resolve) => {
    pending.set(id, resolve);
    send(frame);
  });
}

lines.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(line) as JsonRpcMessage;
  } catch {
    nonJsonStdoutLines += 1;
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id) as (m: JsonRpcMessage) => void;
    pending.delete(msg.id);
    resolve(msg);
  }
});

async function main(): Promise<void> {
  // 1) Mandatory ACP v1 initialize handshake.
  const initResp = await request(initialize);
  if (initResp.error) {
    fail(`initialize returned error ${initResp.error.code}: ${initResp.error.message}`);
  }
  const initResult = initResp.result as { protocolVersion?: unknown } | undefined;
  if (initResult?.protocolVersion !== 1) {
    fail(`initialize: unexpected protocolVersion: ${JSON.stringify(initResp.result)}`);
  }
  console.log("smoke: initialize OK — agent speaks ACP v1");

  // 2) Custom liveness probe (_ping -> pong).
  const pongResp = await request(ping);
  if (pongResp.error) {
    fail(`_ping returned error ${pongResp.error.code}: ${pongResp.error.message}`);
  }
  const pong = pongResp.result;
  const isPong =
    pong === "pong" ||
    pong === true ||
    (typeof pong === "object" && pong !== null && (pong as { pong?: unknown }).pong === true);
  if (!isPong) {
    fail(`_ping: unexpected result ${JSON.stringify(pong)} (expected "pong")`);
  }
  console.log("smoke: ping -> pong OK");

  clearTimeout(timer);
  child.kill("SIGTERM");
  console.log("smoke: PASS");
  process.exit(0);
}

main().catch((err: unknown) => {
  clearTimeout(timer);
  child.kill("SIGTERM");
  const hint = exited ? ` (omp exited with code ${exitCode})` : notAnAcpServerHint();
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  fail(`${message}${hint}`);
});