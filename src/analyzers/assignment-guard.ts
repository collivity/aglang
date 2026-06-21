import type { GraphFact } from './plugin.ts';

function lineOf(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface AssignmentGuardOptions {
  /** Separator between the enum type and its member on the assignment RHS / guard. '.' for most languages, '::' for Rust. */
  enumSeparator: '.' | '::';
  /** Equality operators that count as a guard (e.g. ['=='] or ['==', 'is']). */
  guardOperators: string[];
}

/**
 * Detects `object.property = EnumType<sep>Member` assignments, with a 300-char
 * lookback for a preceding `object.property <op> EnumType<sep>OtherMember` guard.
 * Mirrors the regex+lookback shape already proven in typescript-server.ts/kotlin.ts/
 * csharp.ts (deliberately not shared with them — see round 3 plan, "don't touch
 * working code"). Only matches the enum-qualified RHS form; bare unqualified
 * constants (e.g. Go's `order.Status = StatusActive`) are out of scope — matching
 * them risks false positives on unrelated single-identifier assignments.
 */
export function extractAssignmentGraphFacts(
  content: string,
  filePath: string,
  componentName: string,
  extractorName: string,
  options: AssignmentGuardOptions,
): GraphFact[] {
  const facts: GraphFact[] = [];
  const emitted = new Set<string>();
  const sep = options.enumSeparator;
  const sepPattern = escapeRegExp(sep);
  const guardOpPattern = options.guardOperators.map(escapeRegExp).join('|');

  const assignmentRe = new RegExp(`\\b([A-Za-z_]\\w*)\\.([A-Za-z_]\\w*)\\s*=\\s*([A-Za-z_]\\w*)${sepPattern}([A-Za-z_]\\w*)`, 'g');
  let assignment: RegExpExecArray | null;
  while ((assignment = assignmentRe.exec(content)) !== null) {
    const [, object, property, valueEnum, valueMember] = assignment as unknown as [string, string, string, string, string];
    const before = content.slice(Math.max(0, assignment.index - 300), assignment.index);
    const guardRe = new RegExp(
      `${escapeRegExp(object)}\\.${escapeRegExp(property)}\\s*(?:${guardOpPattern})\\s*${escapeRegExp(valueEnum)}${sepPattern}([A-Za-z_]\\w*)`,
      'g',
    );
    const guards = [...before.matchAll(guardRe)];
    const guard = guards.at(-1);

    const line = lineOf(content, assignment.index);
    const properties: GraphFact['properties'] = {
      object,
      property,
      valueEnum,
      valueMember,
      ...(guard ? { previousMember: guard[1]! } : {}),
    };
    const id = `${extractorName}:${filePath}:${line}:assignment:${JSON.stringify(properties)}`;
    if (emitted.has(id)) continue;
    emitted.add(id);
    facts.push({
      id,
      kind: 'assignment',
      subject: componentName,
      properties,
      confidence: 'definite',
      evidence: {
        extractor: extractorName,
        strategy: 'regex',
        file: filePath,
        line,
        message: `${object}.${property} = ${valueEnum}${sep}${valueMember}`,
      },
    });
  }

  return facts;
}
