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
type DeliveryConfidence = 'low' | 'medium' | 'high' | null
type ParsedDeliveryMeta = {
  confidence: DeliveryConfidence
  reason: string | null
}
export type DeliverySelection = {
  delivery:
    | ({ mode: 'none'; source: 'selected' | 'fallback' } & ParsedDeliveryMeta)
    | ({ mode: 'skill'; skill: string; source: 'selected' } & ParsedDeliveryMeta)
    | ({ mode: 'policy'; policy: string; source: 'selected' } & ParsedDeliveryMeta)
}
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

export type ConvergenceVerdict =
  | 'CONTINUE_CODE_FIX'
  | 'RETRY_LATER'
  | 'ASK_HUMAN'
  | 'TERMINAL'
  | null

export function parseConvergenceVerdict(text: string): ConvergenceVerdict {
  const match = /^VERDICT:\s*(CONTINUE_CODE_FIX|RETRY_LATER|ASK_HUMAN|TERMINAL)\s*$/i.exec(
    finalNonemptyLine(text)
  )
  const value = match?.[1]?.toUpperCase()
  if (
    value === 'CONTINUE_CODE_FIX' ||
    value === 'RETRY_LATER' ||
    value === 'ASK_HUMAN' ||
    value === 'TERMINAL'
  ) {
    return value
  }
  return null
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

function markerValue(text: string, name: string): string | null {
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(text)
  return match?.[1]?.trim() ?? null
}

export function parseDeliverySelection(text: string, availableSkills: string[]): DeliverySelection {
  const confidenceText = markerValue(text, 'CONFIDENCE')?.toLowerCase()
  const confidence =
    confidenceText === 'low' || confidenceText === 'medium' || confidenceText === 'high'
      ? confidenceText
      : null
  const reason = markerValue(text, 'REASON')
  const raw = markerValue(text, 'DELIVERY')
  if (!raw) {
    return {
      delivery: {
        mode: 'none',
        source: 'fallback',
        confidence: 'low',
        reason: 'delivery selector did not report a valid DELIVERY marker',
      },
    }
  }

  if (/^none$/i.test(raw)) {
    return {
      delivery: { mode: 'none', source: 'selected', confidence, reason },
    }
  }

  const skill = /^skill\s+([a-z0-9._-]+)$/i.exec(raw)?.[1]
  const canonicalSkill = skill
    ? availableSkills.find((available) => available.toLowerCase() === skill.toLowerCase())
    : null
  if (canonicalSkill) {
    return {
      delivery: {
        mode: 'skill',
        skill: canonicalSkill,
        source: 'selected',
        confidence,
        reason,
      },
    }
  }

  const policy = /^policy\s+(.+)$/i.exec(raw)?.[1]?.trim()
  if (policy) {
    return {
      delivery: { mode: 'policy', policy, source: 'selected', confidence, reason },
    }
  }

  return {
    delivery: {
      mode: 'none',
      source: 'fallback',
      confidence: 'low',
      reason: `delivery selector returned unsupported delivery: ${raw}`,
    },
  }
}

export function parseReconcileDecision(text: string): ReconcileDecision {
  const match = /^DECISION:\s*(PROCEED|ASK)\s*$/i.exec(firstNonemptyLine(text))
  const value = match?.[1]?.toUpperCase()
  if (value === 'PROCEED' || value === 'ASK') {
    return value
  }
  return null
}
