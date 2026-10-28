// Starts the local payment simulator on 127.0.0.1 (never any other
// interface). See README.md.
//
//   deno run --allow-net=127.0.0.1 --allow-env=PAYMENT_SIMULATOR_CONTROL_TOKEN,PAYMENT_SIMULATOR_PORT server.ts
//
// PAYMENT_SIMULATOR_CONTROL_TOKEN  enables the control API (>= 32 chars
//                                  of [A-Za-z0-9_-]); never printed.
//                                  Unset: provider API only.
// PAYMENT_SIMULATOR_PORT           optional, 1024-65535 (default 59480).
//                                  The Edge Function guard accepts only
//                                  59480, so other ports are for tests.

import { controlTokenProblem, createSimulator, DEFAULT_PORT, newRunId } from './simulator.ts';

export const HOSTNAME = '127.0.0.1';

/** A strictly validated port, or null. */
export function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1024 && n <= 65535 ? n : null;
}

export interface Started {
  port: number;
  runId: string;
  shutdown(): Promise<void>;
}

/** Starts a simulator; port 0 picks a free ephemeral port (tests). */
export function startSimulator(opts: {
  port: number;
  controlToken: string | null;
  runId?: string;
  log?: (line: Record<string, unknown>) => void;
}): Started {
  let port = opts.port;
  const runId = opts.runId ?? newRunId();
  const sim = createSimulator({ port: () => port, controlToken: opts.controlToken, runId, log: opts.log });
  const server = Deno.serve({ hostname: HOSTNAME, port: opts.port, onListen: () => {} }, (req) => sim.handle(req));
  const addr = server.addr as Deno.NetAddr;
  if (addr.hostname !== HOSTNAME) {
    void server.shutdown();
    throw new Error('the simulator must listen on 127.0.0.1 only');
  }
  port = addr.port;
  return { port, runId, shutdown: () => server.shutdown() };
}

if (import.meta.main) {
  const port = parsePort(Deno.env.get('PAYMENT_SIMULATOR_PORT'));
  if (port === null) {
    console.error('PAYMENT_SIMULATOR_PORT must be an integer from 1024 to 65535.');
    Deno.exit(2);
  }
  const token = Deno.env.get('PAYMENT_SIMULATOR_CONTROL_TOKEN') ?? null;
  const problem = token === null ? null : controlTokenProblem(token);
  if (problem) {
    console.error(`PAYMENT_SIMULATOR_CONTROL_TOKEN ${problem}.`);
    Deno.exit(2);
  }
  const started = startSimulator({ port, controlToken: token, log: (line) => console.log(JSON.stringify(line)) });
  console.log(JSON.stringify({
    event: 'simulator.listening',
    url: `http://${HOSTNAME}:${started.port}`,
    run_id: started.runId,
    control_api: token === null ? 'disabled' : 'enabled',
    note: 'local payment simulator; not Razorpay; no money moves',
  }));
}
