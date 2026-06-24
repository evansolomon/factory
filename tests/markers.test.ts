import { describe, expect, test } from 'bun:test'
import {
  parseConvergenceVerdict,
  parseReconcileDecision,
  parseRemedy,
  parseReviewVerdict,
  parseShip,
  parseTriage,
} from '../src/markers.ts'

describe('marker parsing', () => {
  test('parses triage from the final two marker lines', () => {
    expect(
      parseTriage('Reasoning is allowed before the markers.\nCOMPLEXITY: TRIVIAL\nUSER-FACING: YES')
    ).toEqual({
      trivial: true,
      userFacing: true,
    })
  })

  test('defaults malformed triage markers to complex and not user-facing', () => {
    expect(parseTriage('COMPLEXITY: MAYBE\nUSER-FACING: MAYBE')).toEqual({
      trivial: false,
      userFacing: false,
    })
  })

  test('does not accept non-final review verdicts', () => {
    expect(parseReviewVerdict('VERDICT: PASS\n\n## Findings\nnone')).toBeNull()
    expect(parseReviewVerdict('## Findings\nnone\n\nVERDICT: PASS')).toBe('PASS')
    expect(parseReviewVerdict('> VERDICT: PASS')).toBeNull()
  })

  test('does not accept non-final convergence verdicts', () => {
    expect(parseConvergenceVerdict('VERDICT: CONTINUE_CODE_FIX\n\nsame root cause')).toBeNull()
    expect(parseConvergenceVerdict('SUMMARY: fixable\nVERDICT: CONTINUE_CODE_FIX')).toBe(
      'CONTINUE_CODE_FIX'
    )
    expect(parseConvergenceVerdict('same root cause\n\nVERDICT: TERMINAL')).toBe('TERMINAL')
    expect(parseConvergenceVerdict('VERDICT: RETRY_LATER')).toBe('RETRY_LATER')
    expect(parseConvergenceVerdict('VERDICT: ASK_HUMAN')).toBe('ASK_HUMAN')
    expect(parseConvergenceVerdict('VERDICT: CONTINUE')).toBeNull()
    expect(parseConvergenceVerdict('VERDICT: STUCK')).toBeNull()
    expect(parseConvergenceVerdict('`VERDICT: CONTINUE_CODE_FIX`')).toBeNull()
  })

  test('parses ship only from the final line', () => {
    expect(parseShip('opened PR\nSHIP: OK')).toEqual({ ok: true })
    expect(parseShip('SHIP: OK\nfollow-up text')).toEqual({
      ok: false,
      reason: 'ship did not report success',
    })
    expect(parseShip('could not push\nSHIP: FAILED remote rejected')).toEqual({
      ok: false,
      reason: 'remote rejected',
    })
  })

  test('parses the remedy verdict only from the final line', () => {
    expect(parseRemedy('ran bun install\nSUMMARY: deps were missing\nVERDICT: ENV-FIXED')).toBe(
      'ENV-FIXED'
    )
    expect(parseRemedy('SUMMARY: assertion failed\nVERDICT: CODE')).toBe('CODE')
    expect(parseRemedy('VERDICT: ENV-FIXED\ntrailing note')).toBeNull()
    expect(parseRemedy('VERDICT: MAYBE')).toBeNull()
  })

  test('parses reconcile only from the first nonempty line', () => {
    expect(parseReconcileDecision('DECISION: ASK\n\nWhat should the label be?')).toBe('ASK')
    expect(parseReconcileDecision('\nDECISION: PROCEED\nAssuming the default.')).toBe('PROCEED')
    expect(parseReconcileDecision('I might ask.\nDECISION: ASK')).toBeNull()
    expect(parseReconcileDecision('> DECISION: ASK')).toBeNull()
  })
})
