function nonemptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

// ONE convention for every marker parser: scan the whole output and take the
// LAST line that matches the marker. Prompts ask for the marker as the final
// line, but models add preamble and trailing prose; anchoring to a fixed
// position (first line, exact last line) silently mis-parsed real outputs —
// including the reconcile escalation valve, which failed OPEN (proceed) on any
// preamble. Last-match wins because a stage's genuine verdict supersedes any
// earlier draft or quoted marker.
function lastMarkerMatch(text: string, pattern: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null
  for (const line of nonemptyLines(text)) {
    const match = pattern.exec(line)
    if (match) {
      last = match
    }
  }
  return last
}

export type TriageResult = {
  trivial: boolean
  userFacing: boolean
  complexityMarker: boolean
  userFacingMarker: boolean
  // Raw IMPLEMENTER marker value (only requested when an implementer pool is
  // configured). Pure extraction — DEFAULT and unknown names pass through;
  // the conductor resolves against the pool.
  implementer: string | null
}
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
// FLAKE — a transient/external failure (back off and retry);
// GATE-MISCONFIGURED — the verify command itself is broken; `gateFix` carries
// the doctor's corrected command (required for the verdict to be usable).
export type RemedyVerdict =
  | 'ENV-FIXED'
  | 'ENV-BLOCKED'
  | 'CODE'
  | 'FLAKE'
  | 'GATE-MISCONFIGURED'
  | null

export function parseShipUrl(text: string): string | null {
  const value = lastMarkerMatch(text, /^URL:\s*(\S+)\s*$/i)?.[1] ?? null
  return value && /^https?:\/\//.test(value) ? value : null
}

export function parseMoot(text: string): boolean | null {
  const value = lastMarkerMatch(text, /^MOOT:\s*(YES|NO)\s*$/i)?.[1]?.toUpperCase()
  return value === 'YES' ? true : value === 'NO' ? false : null
}

export function parseGateFix(text: string): string | null {
  return lastMarkerMatch(text, /^GATE-FIX:\s*(.+)$/i)?.[1]?.trim() ?? null
}

export function parseTriage(text: string): TriageResult {
  const complexity = lastMarkerMatch(
    text,
    /^COMPLEXITY:\s*(TRIVIAL|COMPLEX)\s*$/i
  )?.[1]?.toUpperCase()
  const userFacing = lastMarkerMatch(text, /^USER-FACING:\s*(YES|NO)\s*$/i)?.[1]?.toUpperCase()
  const implementer = lastMarkerMatch(text, /^IMPLEMENTER:\s*(.+)$/i)?.[1]?.trim() ?? null

  return {
    trivial: complexity === 'TRIVIAL',
    userFacing: userFacing === 'YES',
    // Missing markers still resolve (complex / not-user-facing) but callers can
    // now see that the resolution was a default, not a model decision — a missing
    // USER-FACING silently disabled the UX review gate before this.
    complexityMarker: complexity !== undefined,
    userFacingMarker: userFacing !== undefined,
    implementer,
  }
}

export function parseReviewVerdict(text: string): 'PASS' | 'FAIL' | null {
  const value = lastMarkerMatch(text, /^VERDICT:\s*(PASS|FAIL)\s*$/i)?.[1]?.toUpperCase()
  return value === 'PASS' || value === 'FAIL' ? value : null
}

export type ConvergenceVerdict =
  | 'CONTINUE_CODE_FIX'
  | 'RETRY_LATER'
  | 'ASK_HUMAN'
  | 'TERMINAL'
  | null

export function parseConvergenceVerdict(text: string): ConvergenceVerdict {
  const value = lastMarkerMatch(
    text,
    /^VERDICT:\s*(CONTINUE_CODE_FIX|RETRY_LATER|ASK_HUMAN|TERMINAL)\s*$/i
  )?.[1]?.toUpperCase()
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
  const value = lastMarkerMatch(
    text,
    /^VERDICT:\s*(ENV-FIXED|ENV-BLOCKED|CODE|FLAKE|GATE-MISCONFIGURED)\s*$/i
  )?.[1]?.toUpperCase()
  if (
    value === 'ENV-FIXED' ||
    value === 'ENV-BLOCKED' ||
    value === 'CODE' ||
    value === 'FLAKE' ||
    value === 'GATE-MISCONFIGURED'
  ) {
    return value
  }
  return null
}

export function parseShip(text: string): ShipResult {
  const match = lastMarkerMatch(text, /^SHIP:\s*(OK|FAILED)\s*(.*)$/i)
  if (match?.[1]?.toUpperCase() === 'OK') {
    return { ok: true }
  }
  return { ok: false, reason: match?.[2]?.trim() || 'ship did not report success' }
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
  const value = lastMarkerMatch(text, /^DECISION:\s*(PROCEED|ASK)\s*$/i)?.[1]?.toUpperCase()
  if (value === 'PROCEED' || value === 'ASK') {
    return value
  }
  return null
}
