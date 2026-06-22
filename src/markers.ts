function nonemptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function firstNonemptyLine(text: string): string {
  return nonemptyLines(text)[0] ?? ''
}

function finalNonemptyLine(text: string): string {
  return nonemptyLines(text).at(-1) ?? ''
}

export type TriageResult = { trivial: boolean; userFacing: boolean }
export type ShipResult = { ok: true } | { ok: false; reason: string }
export type ReconcileDecision = 'PROCEED' | 'ASK' | null
// The verify-gate doctor's classification of a failure (see remediatePrompt):
// ENV-FIXED — environment problem the doctor repaired (re-run verify);
// ENV-BLOCKED — environment problem it couldn't fix (back off);
// CODE — a real code/test defect (route to the code-fix loop);
// FLAKE — a transient/external failure (back off and retry).
export type RemedyVerdict = 'ENV-FIXED' | 'ENV-BLOCKED' | 'CODE' | 'FLAKE' | null

export function parseTriage(text: string): TriageResult {
  const lines = nonemptyLines(text)
  const userFacingLine = lines.at(-1) ?? ''
  const complexityLine = lines.at(-2) ?? ''
  const complexity = /^COMPLEXITY:\s*(TRIVIAL|COMPLEX)\s*$/i
    .exec(complexityLine)?.[1]
    ?.toUpperCase()
  const userFacing = /^USER-FACING:\s*(YES|NO)\s*$/i.exec(userFacingLine)?.[1]?.toUpperCase()

  return {
    trivial: complexity === 'TRIVIAL',
    userFacing: userFacing === 'YES',
  }
}

export function parseReviewVerdict(text: string): 'PASS' | 'FAIL' | null {
  const match = /^VERDICT:\s*(PASS|FAIL)\s*$/i.exec(finalNonemptyLine(text))
  const value = match?.[1]?.toUpperCase()
  return value === 'PASS' || value === 'FAIL' ? value : null
}

export function parseConvergenceVerdict(text: string): 'CONTINUE' | 'STUCK' | null {
  const match = /^VERDICT:\s*(CONTINUE|STUCK)\s*$/i.exec(finalNonemptyLine(text))
  const value = match?.[1]?.toUpperCase()
  return value === 'CONTINUE' || value === 'STUCK' ? value : null
}

export function parseRemedy(text: string): RemedyVerdict {
  const match = /^VERDICT:\s*(ENV-FIXED|ENV-BLOCKED|CODE|FLAKE)\s*$/i.exec(finalNonemptyLine(text))
  const value = match?.[1]?.toUpperCase()
  if (value === 'ENV-FIXED' || value === 'ENV-BLOCKED' || value === 'CODE' || value === 'FLAKE') {
    return value
  }
  return null
}

export function parseShip(text: string): ShipResult {
  const line = finalNonemptyLine(text)
  if (/^SHIP:\s*OK\s*$/i.test(line)) {
    return { ok: true }
  }
  const failed = /^SHIP:\s*FAILED\s*(.*)$/i.exec(line)
  return { ok: false, reason: failed?.[1]?.trim() || 'ship did not report success' }
}

export function parseReconcileDecision(text: string): ReconcileDecision {
  const match = /^DECISION:\s*(PROCEED|ASK)\s*$/i.exec(firstNonemptyLine(text))
  const value = match?.[1]?.toUpperCase()
  if (value === 'PROCEED' || value === 'ASK') {
    return value
  }
  return null
}
