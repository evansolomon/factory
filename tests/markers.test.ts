import { describe, expect, test } from 'bun:test'
import {
  parseConvergenceVerdict,
  parseReconcileDecision,
  parseRemedy,
  parseReviewVerdict,
  parseShip,
  parseTriage,
} from '../src/markers.ts'

// One convention across all parsers: a marker is a whole (trimmed) line, found
// anywhere in the output, last match wins. Position-anchored parsing silently
// mis-read real model output — the reconcile valve failed OPEN on any preamble.

describe('marker parsing', () => {
  test('parses triage markers anywhere in the output', () => {
    expect(
      parseTriage('Reasoning is allowed before the markers.\nCOMPLEXITY: TRIVIAL\nUSER-FACING: YES')
    ).toEqual({
      trivial: true,
      userFacing: true,
      complexityMarker: true,
      userFacingMarker: true,
    })
    // Trailing prose or reordered markers no longer break parsing.
    expect(
      parseTriage('USER-FACING: NO\nCOMPLEXITY: COMPLEX\nNote: repo has few tests.').trivial
    ).toBe(false)
    expect(parseTriage('COMPLEXITY: TRIVIAL\nUSER-FACING: YES\ntrailing note').userFacing).toBe(
      true
    )
  })

  test('defaults malformed triage markers and reports them as defaults', () => {
    expect(parseTriage('COMPLEXITY: MAYBE\nUSER-FACING: MAYBE')).toEqual({
      trivial: false,
      userFacing: false,
      complexityMarker: false,
      userFacingMarker: false,
    })
  })

  test('parses review verdicts anywhere, last match wins', () => {
    expect(parseReviewVerdict('## Findings\nnone\n\nVERDICT: PASS')).toBe('PASS')
    expect(parseReviewVerdict('VERDICT: PASS\n\n## Findings\nnone')).toBe('PASS')
    expect(parseReviewVerdict('VERDICT: PASS\n\nOn reflection:\nVERDICT: FAIL')).toBe('FAIL')
    // A quoted or inline marker is not a whole marker line.
    expect(parseReviewVerdict('> VERDICT: PASS')).toBeNull()
    expect(parseReviewVerdict('no verdict here')).toBeNull()
  })

  test('parses convergence verdicts anywhere, last match wins', () => {
    expect(parseConvergenceVerdict('VERDICT: CONTINUE_CODE_FIX\n\nsame root cause')).toBe(
      'CONTINUE_CODE_FIX'
    )
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

  test('parses ship anywhere, last match wins', () => {
    expect(parseShip('opened PR\nSHIP: OK')).toEqual({ ok: true })
    expect(parseShip('SHIP: OK\nfollow-up text')).toEqual({ ok: true })
    expect(parseShip('could not push\nSHIP: FAILED remote rejected')).toEqual({
      ok: false,
      reason: 'remote rejected',
    })
    expect(parseShip('no marker at all')).toEqual({
      ok: false,
      reason: 'ship did not report success',
    })
  })

  test('parses the remedy verdict anywhere, last match wins', () => {
    expect(parseRemedy('ran bun install\nSUMMARY: deps were missing\nVERDICT: ENV-FIXED')).toBe(
      'ENV-FIXED'
    )
    expect(parseRemedy('SUMMARY: assertion failed\nVERDICT: CODE')).toBe('CODE')
    expect(parseRemedy('VERDICT: ENV-FIXED\ntrailing note')).toBe('ENV-FIXED')
    expect(parseRemedy('VERDICT: MAYBE')).toBeNull()
  })

  test('parses reconcile decisions anywhere — preamble no longer fails open', () => {
    expect(parseReconcileDecision('DECISION: ASK\n\nWhat should the label be?')).toBe('ASK')
    expect(parseReconcileDecision('\nDECISION: PROCEED\nAssuming the default.')).toBe('PROCEED')
    // The exact case that used to fail open (null → proceed): preamble first.
    expect(parseReconcileDecision('I might ask.\nDECISION: ASK')).toBe('ASK')
    expect(parseReconcileDecision('> DECISION: ASK')).toBeNull()
    expect(parseReconcileDecision('no decision at all')).toBeNull()
  })
})

import { clipFailureOutput } from '../src/conductor.ts'
import { parseGateFix } from '../src/markers.ts'

describe('gate repair and failure clipping', () => {
  test('parses GATE-MISCONFIGURED and its GATE-FIX line', () => {
    const out =
      'The script does not exist.\nSUMMARY: wrong path\nGATE-FIX: yc rspec spec/real_spec.rb\nVERDICT: GATE-MISCONFIGURED'
    expect(parseGateFix(out)).toBe('yc rspec spec/real_spec.rb')
  })

  test('clipFailureOutput keeps both the head and the tail of long output', () => {
    const text = `HEAD-MARKER\n${'x'.repeat(50_000)}\nTAIL-MARKER`
    const clipped = clipFailureOutput(text)
    expect(clipped).toContain('HEAD-MARKER')
    expect(clipped).toContain('TAIL-MARKER')
    expect(clipped).toContain('chars clipped')
    expect(clipped.length).toBeLessThan(text.length)
    expect(clipFailureOutput('short output')).toBe('short output')
  })
})

import { parseMoot, parseShipUrl } from '../src/markers.ts'

describe('moot and ship-url markers', () => {
  test('parses MOOT verdicts', () => {
    expect(parseMoot('checked git log\nSUMMARY: landed in 422169b\nMOOT: YES')).toBe(true)
    expect(parseMoot('SUMMARY: still relevant\nMOOT: NO')).toBe(false)
    expect(parseMoot('no verdict')).toBeNull()
  })

  test('parses ship URLs and rejects non-urls', () => {
    expect(
      parseShipUrl('opened MR\nURL: https://gitlab.com/yc/yc/-/merge_requests/1\nSHIP: OK')
    ).toBe('https://gitlab.com/yc/yc/-/merge_requests/1')
    expect(parseShipUrl('URL: not-a-url\nSHIP: OK')).toBeNull()
    expect(parseShipUrl('SHIP: OK')).toBeNull()
  })
})
