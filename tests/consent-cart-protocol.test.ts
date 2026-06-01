import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { tokenize } from '../src/lexer.ts';
import { parse } from '../src/parser.ts';
import { check } from '../src/checker.ts';
import { emitArtifact } from '../src/emitters/artifact.ts';
import { generateDeltaAssertions } from '../src/runtime/delta-assert.ts';
import { runGate } from '../src/runtime/gate.ts';

const exampleRoot = join(import.meta.dirname, '..', 'examples', 'consent-and-cart-protocol');
const exampleAg = readFileSync(join(exampleRoot, 'architecture.ag'), 'utf8');

function compile(source: string) {
  const program = parse(tokenize(source));
  const errors = check(program);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join('\n'));
  }
  return emitArtifact(program, 'consent-cart-test.ag');
}

describe('consent and cart protocol example', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function copyExampleProject(): string {
    const dir = join(tmpdir(), `aglang-consent-cart-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    cpSync(join(exampleRoot, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(exampleRoot, '.aglang'), join(dir, '.aglang'), { recursive: true });
    return dir;
  }

  it('blocks unguarded consent acceptance', async () => {
    const dir = copyExampleProject();
    const artifact = compile(exampleAg);
    const source = join(dir, 'src', 'violations', 'consent-skip-banner.ts');

    const delta = await generateDeltaAssertions([
      { componentName: 'ConsentModule', files: [source] },
    ], artifact, { projectRoot: dir });

    expect(delta.transitionFacts.some(f => f.to === 'Accepted')).toBe(true);
    expect(delta.blockingTransitionFacts.some(f => f.to === 'Accepted')).toBe(true);

    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.some(v => v.type === 'state_machine_violation')).toBe(true);
  });

  it('blocks illegal cart phase jump Empty -> MultiItem', async () => {
    const dir = copyExampleProject();
    const artifact = compile(exampleAg);
    const source = join(dir, 'src', 'violations', 'cart-skip-single.ts');

    const delta = await generateDeltaAssertions([
      { componentName: 'CartModule', files: [source] },
    ], artifact, { projectRoot: dir });

    expect(delta.transitionFacts.some(f => f.to === 'MultiItem')).toBe(true);
    expect(delta.blockingTransitionFacts.some(f => f.to === 'MultiItem')).toBe(true);

    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.some(v => v.type === 'state_machine_violation')).toBe(true);
  });

  it('allows guarded consent and legal cart transitions', async () => {
    const dir = copyExampleProject();
    const artifact = compile(exampleAg);

    const consentSource = join(dir, 'src', 'consent.ts');
    writeFileSync(consentSource, `
import { ConsentStatus } from './compliance.js';
export interface UserSession { consent: ConsentStatus }
export function presentBanner(session: UserSession): void {
  if (session.consent === ConsentStatus.Unknown) {
    session.consent = ConsentStatus.Presented;
  }
}
export function acceptConsent(session: UserSession): void {
  if (session.consent === ConsentStatus.Presented) {
    session.consent = ConsentStatus.Accepted;
  }
}
`);

    const cartSource = join(dir, 'src', 'cart.ts');
    writeFileSync(cartSource, `
export enum CartPhase { Empty = 'Empty', SingleItem = 'SingleItem', MultiItem = 'MultiItem' }
export interface SharedCart { phase: CartPhase }
export function addFirstItem(cart: SharedCart): void {
  if (cart.phase === CartPhase.Empty) cart.phase = CartPhase.SingleItem;
}
`);

    const delta = await generateDeltaAssertions([
      { componentName: 'ConsentModule', files: [consentSource] },
      { componentName: 'CartModule', files: [cartSource] },
    ], artifact, { projectRoot: dir });

    expect(delta.blockingTransitionFacts).toHaveLength(0);
    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(true);
  });

  it('blocks checkout that bypasses Compliance on the way to ApiClient', async () => {
    const dir = copyExampleProject();
    const artifact = compile(exampleAg);
    const checkout = join(dir, 'src', 'checkout.ts');
    const api = join(dir, 'src', 'api.ts');

    const delta = await generateDeltaAssertions([
      { componentName: 'Checkout', files: [checkout, api] },
      { componentName: 'ApiClient', files: [api] },
    ], artifact, { projectRoot: dir });

    expect(delta.blockingRequireFlowFacts.length).toBeGreaterThan(0);

    const verdict = await runGate(artifact, delta);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.some(v => v.type === 'require_flow_violation')).toBe(true);
  });

  it('passes checkout that imports Compliance before calling the API', async () => {
    const dir = copyExampleProject();
    const artifact = compile(exampleAg);
    const checkout = join(dir, 'src', 'checkout-good.ts');
    const compliance = join(dir, 'src', 'compliance.ts');
    const api = join(dir, 'src', 'api.ts');

    const delta = await generateDeltaAssertions([
      { componentName: 'Checkout', files: [checkout] },
      { componentName: 'Compliance', files: [compliance, api] },
      { componentName: 'ApiClient', files: [api] },
    ], artifact, { projectRoot: dir });

    const requireViolations = delta.blockingRequireFlowFacts.filter(
      f => f.from === 'Checkout' && f.to === 'ApiClient',
    );
    expect(requireViolations).toHaveLength(0);

    const transitionViolations = delta.blockingTransitionFacts;
    const verdict = await runGate(artifact, delta);
    expect(transitionViolations).toHaveLength(0);
    expect(verdict.passed).toBe(true);
  });
});
