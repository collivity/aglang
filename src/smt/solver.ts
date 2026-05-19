// Z3 solver wrapper using z3-solver (WASM)
import { init } from 'z3-solver';

export interface SolverResult {
  sat: boolean;       // true = violation found, false = architecture is sound
  model?: string;     // raw Z3 model string when sat=true
}

let z3Context: Awaited<ReturnType<typeof init>> | null = null;

async function getZ3() {
  if (!z3Context) {
    z3Context = await init();
  }
  return z3Context;
}

export async function checkConstraints(smtStatements: string[]): Promise<SolverResult> {
  const { Context } = await getZ3();
  const ctx = new Context('main');
  const solver = new ctx.Solver();

  const script = smtStatements.join('\n');

  try {
    // Parse all assertions into the solver
    solver.fromString(script);

    const result = await solver.check();

    if (result === 'unsat') {
      // Contradiction found — delta flow violated a deny-flow constraint
      return { sat: false };
    } else if (result === 'sat') {
      // Satisfiable — no constraint violations
      return { sat: true };
    } else {
      // 'unknown' — Z3 timed out or hit a resource limit. Fail closed.
      throw new Error(`Z3 solver returned 'unknown' (timeout or resource limit). Cannot prove architectural safety — commit blocked. Try simplifying your invariants or increasing Z3 timeout.`);
    }
  } catch (err) {
    throw new Error(`Z3 solver error: ${(err as Error).message}\nScript:\n${script}`);
  }
}
