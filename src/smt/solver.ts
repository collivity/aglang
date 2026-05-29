// Z3 solver wrapper using z3-solver (WASM)
import { init } from 'z3-solver';

export interface SolverResult {
  sat: boolean;       // true = violation found, false = architecture is sound
  model?: string;     // raw Z3 model string when sat=true
}

export interface SolverDetailedResult {
  status: 'sat' | 'unsat' | 'unknown' | 'error';
  sat: boolean;
  elapsed_ms: number;
  model?: string;
  reason?: string;
}

let z3Context: Awaited<ReturnType<typeof init>> | null = null;

async function getZ3() {
  if (!z3Context) {
    z3Context = await init();
  }
  return z3Context;
}

export async function checkConstraints(smtStatements: string[]): Promise<SolverResult> {
  const result = await checkConstraintsDetailed(smtStatements);
  if (result.status === 'unsat') return { sat: false };
  if (result.status === 'sat') return { sat: true, ...(result.model ? { model: result.model } : {}) };
  if (result.status === 'unknown') {
    throw new Error(`Z3 solver returned 'unknown' (timeout or resource limit). Cannot prove architectural safety — commit blocked. Try simplifying your invariants or increasing Z3 timeout.`);
  }
  throw new Error(result.reason ?? 'Z3 solver error');
}

export async function checkConstraintsDetailed(
  smtStatements: string[],
  options: { timeoutMs?: number } = {},
): Promise<SolverDetailedResult> {
  const { Context } = await getZ3();
  const ctx = new Context('main');
  const solver = new ctx.Solver();

  const timeout = options.timeoutMs ? [`(set-option :timeout ${Math.max(1, Math.floor(options.timeoutMs))})`] : [];
  const script = [...timeout, ...smtStatements].join('\n');
  const started = Date.now();

  try {
    // Parse all assertions into the solver
    solver.fromString(script);

    const result = await solver.check();
    const elapsed_ms = Date.now() - started;

    if (result === 'unsat') {
      // Contradiction found — delta flow violated a deny-flow constraint
      return { status: 'unsat', sat: false, elapsed_ms };
    } else if (result === 'sat') {
      // Satisfiable — no constraint violations
      return { status: 'sat', sat: true, elapsed_ms };
    } else {
      return { status: 'unknown', sat: false, elapsed_ms, reason: 'timeout or resource limit' };
    }
  } catch (err) {
    return {
      status: 'error',
      sat: false,
      elapsed_ms: Date.now() - started,
      reason: `Z3 solver error: ${(err as Error).message}\nScript:\n${script}`,
    };
  }
}
