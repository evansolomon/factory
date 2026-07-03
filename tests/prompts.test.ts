import { describe, expect, test } from 'bun:test'
import {
  consolidatePrompt,
  convergePrompt,
  correctionPrompt,
  critiquePrompt,
  deploySafetyPrompt,
  feedbackAnalysisPrompt,
  fixPrompt,
  implementPrompt,
  planPrompt,
  postmortemPrompt,
  prototypePrompt,
  reconcilePrompt,
  remediatePrompt,
  rescuePrompt,
  reviewPrompt,
  securityPrompt,
  triagePrompt,
  uxReviewPrompt,
} from '../src/prompts.ts'

const guidance = [
  '## Learned lessons (auto-applied; edit with `factory lessons edit <id>`)',
  '- [global abc123] Keep marker contracts stable.',
].join('\n')

describe('triage prompt implementer routing', () => {
  test('an empty pool keeps the two-marker contract with no IMPLEMENTER anywhere', () => {
    const prompt = triagePrompt('Fix the typo', null, [])

    expect(prompt).toContain(
      'Output ONLY these two final lines:\nCOMPLEXITY: TRIVIAL|COMPLEX\nUSER-FACING: YES|NO'
    )
    expect(prompt).toContain('Classify the task below on two axes.')
    expect(prompt).not.toContain('IMPLEMENTER')
  })

  // Frozen copy of the pre-pool triage prompt: the empty-pool contract is
  // byte-identity with the two-axis prompt that shipped before routing existed,
  // not just substring presence. An intentional edit to the shared template
  // text must update this literal in the same change.
  test('an empty pool renders the pre-pool two-axis prompt byte-for-byte', () => {
    expect(
      triagePrompt('Fix the typo', null, [])
    ).toBe(`Classify the task below on two axes. Look at the repo briefly if it helps.

COMPLEXITY — decides whether the full planning ensemble (research, two competing plans, cross-critique, reconcile, revise, select) runs before implementation. That ensemble costs real money and ~20+ minutes; it earns its cost ONLY when there are genuine design choices to compare. TRIVIAL tasks skip straight to implementation and are STILL fully reviewed by the expert panel and verified — trivial is a routing decision, not a safety decision.

TRIVIAL — a competent engineer would just start typing: the change is mechanical or obvious once stated, however many lines it touches. One-to-few-line edits, renames, deletions, flag/config/dependency changes, adding an option that mirrors an existing one, an obvious localized fix, updating text or docs.
COMPLEX — a competent engineer would sketch a design first: real alternatives exist and choosing wrong is costly; or the task is ambiguous, spans multiple components with coupling decisions, changes a data model or API contract, or is security/data-sensitive.

Calibration: over-classifying as COMPLEX has been this system's dominant failure (dozens of real tasks, zero classified TRIVIAL — including adding a single build flag). Do not use COMPLEX as a hedge; the review panel and verify gate are the safety net either way. Genuinely torn AFTER thinking it through → COMPLEX.

USER-FACING:
YES — the change alters something an end user sees or interacts with: UI, a page/screen/component, styling, layout, copy/labels, or an interaction flow.
NO — purely internal: backend/API with no UI, data, infra, build, tooling, or an internal refactor.

Examples:
- "Bump the eslint version in package.json" → TRIVIAL, NO
- "Fix the typo on the login button" → TRIVIAL, YES
- "Rename \`foo\` to \`userId\` in cache.ts" → TRIVIAL, NO
- "Make the release binaries smaller, e.g. try --minify" → TRIVIAL, NO
- "Amend the last commit message; it's malformed" → TRIVIAL, NO
- "Add a --force flag that skips the confirmation prompt" → TRIVIAL, NO
- "Add a settings page for notification preferences" → COMPLEX, YES
- "Add pagination to the transactions API" → COMPLEX, NO
- "Sync RSVP state between the two calendar systems" → COMPLEX, NO

## Task
Fix the typo

Output ONLY these two final lines:
COMPLEXITY: TRIVIAL|COMPLEX
USER-FACING: YES|NO`)
  })

  test('a non-empty pool lists entries and requests the third marker line', () => {
    const prompt = triagePrompt('Fix the typo', null, [
      { name: 'quick', label: 'codex:gpt-5.4-mini', description: 'Small mechanical edits' },
      { name: 'local', label: 'claude', description: null },
    ])

    expect(prompt).toContain('Classify the task below on three axes.')
    expect(prompt).toContain('- quick — codex:gpt-5.4-mini: Small mechanical edits')
    expect(prompt).toContain('- local — claude')
    // Conservative selection guidance: pool only for clearly easy AND low-risk.
    expect(prompt).toContain('clearly easy AND low-risk')
    expect(prompt).toContain('Genuinely torn → DEFAULT.')
    // The original two markers are still requested, plus the third line.
    expect(prompt).toContain(
      'Output ONLY these three final lines:\nCOMPLEXITY: TRIVIAL|COMPLEX\nUSER-FACING: YES|NO\nIMPLEMENTER: quick|local|DEFAULT'
    )
  })
})

describe('feedback prompts', () => {
  test('feedbackAnalysisPrompt requires abstraction and root-cause inference', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Inferred abstract problem or root cause')
    expect(prompt).toContain('First infer the abstraction/root cause')
  })

  test('feedbackAnalysisPrompt requires inspecting other applicable instances', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Other applicable concrete instances')
    expect(prompt).toContain('then search downward for concrete affected cases')
  })

  test('feedbackAnalysisPrompt requires non-applicable cases', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Non-applicable look-alikes')
  })

  test('feedbackAnalysisPrompt requires changing only justified cases', () => {
    const prompt = feedbackAnalysisPrompt('Fix layout', 'Button wraps.', 'diff --git', 'Plan')

    expect(prompt).toContain('Change only cases justified by that abstraction')
  })

  test('fixPrompt keeps feedback analysis distinct from learned guidance', () => {
    const prompt = fixPrompt(
      'Fix layout',
      'Plan',
      'Human feedback requires a follow-up fix pass.',
      [],
      'diff --git',
      true,
      null,
      guidance,
      'The root cause is narrow buttons.'
    )

    expect(prompt).toContain(guidance)
    expect(prompt).toContain('## Human feedback analysis')
    expect(prompt).toContain('The root cause is narrow buttons.')
  })

  test('implementPrompt keeps feedback analysis distinct from learned guidance', () => {
    const prompt = implementPrompt(
      'Fix layout',
      'Plan',
      'bun test',
      false,
      null,
      guidance,
      'The root cause is narrow buttons.'
    )

    expect(prompt).toContain(guidance)
    expect(prompt).toContain('## Human feedback analysis')
    expect(prompt).toContain('The root cause is narrow buttons.')
  })

  test('prototypePrompt includes the marker contract, no-prototype option, and examples', () => {
    const prompt = prototypePrompt('Task', 'Plan', 'Risk', guidance)

    expect(prompt).toContain('PROTOTYPE: YES|NO')
    expect(prompt).toContain('ARTIFACT: <relative basename or none>')
    expect(prompt).toContain('REASON: <one sentence>')
    expect(prompt).toContain('For PROTOTYPE: NO, set ARTIFACT: none')
    expect(prompt).toContain('static HTML')
    expect(prompt).toContain('Mermaid markdown')
    expect(prompt).toContain('state-machine specs')
    expect(prompt).toContain('will not pause for approval')
  })

  test('implementPrompt includes prototype context when provided', () => {
    const prompt = implementPrompt(
      'Task',
      'Plan',
      null,
      false,
      null,
      null,
      null,
      'Decision: created'
    )

    expect(prompt).toContain('## Prototype artifact (advisory)')
    expect(prompt).toContain('Decision: created')
  })

  test('fixPrompt includes prototype context when provided', () => {
    const prompt = fixPrompt(
      'Task',
      'Plan',
      'Failed',
      [],
      'diff',
      false,
      null,
      null,
      null,
      'Decision: created'
    )

    expect(prompt).toContain('## Prototype artifact (advisory)')
    expect(prompt).toContain('Decision: created')
  })
})

describe('learned lesson prompt injection', () => {
  test('plan keeps legacy lessons and structured learned lessons separate', () => {
    const prompt = planPrompt(
      'Task',
      'bun test',
      null,
      '- Legacy repo lesson.',
      guidance,
      'Research facts.',
      false
    )

    expect(prompt).toContain('## Lessons from past runs (apply these)\n- Legacy repo lesson.')
    expect(prompt).toContain(guidance)
  })

  test('critique includes learned lessons', () => {
    expect(critiquePrompt('Task', 'Plan', null, null, guidance, null)).toContain(guidance)
  })

  test('reconcile includes learned lessons', () => {
    expect(reconcilePrompt('Task', [{ label: 'a', text: 'Plan' }], [], null, guidance)).toContain(
      guidance
    )
  })

  test('implement includes learned lessons', () => {
    expect(implementPrompt('Task', 'Plan', null, false, null, guidance)).toContain(guidance)
  })

  test('fix includes learned lessons', () => {
    expect(fixPrompt('Task', 'Plan', 'Failed', [], 'diff', false, null, guidance)).toContain(
      guidance
    )
  })

  test('review includes learned lessons', () => {
    expect(reviewPrompt('Task', null, 'Plan', 'diff', null, guidance)).toContain(guidance)
  })

  test('security includes learned lessons', () => {
    expect(securityPrompt('Task', 'Plan', 'diff', null, guidance)).toContain(guidance)
  })

  test('deploy safety includes learned lessons', () => {
    expect(deploySafetyPrompt('Task', 'Plan', 'diff', null, guidance)).toContain(guidance)
  })

  test('UX review includes learned lessons', () => {
    expect(uxReviewPrompt('Task', 'Plan', 'diff', null, guidance)).toContain(guidance)
  })

  test('consolidate includes learned lessons', () => {
    expect(
      consolidatePrompt(
        'Task',
        'Plan',
        'diff',
        [{ label: 'correctness', text: 'ok' }],
        null,
        guidance
      )
    ).toContain(guidance)
  })

  test('remediate includes learned lessons', () => {
    expect(remediatePrompt('Task', 'bun test', 'failed', [], guidance)).toContain(guidance)
  })

  test('postmortem includes learned lessons', () => {
    expect(postmortemPrompt('Task', [], 'diff', 'reason', guidance)).toContain(guidance)
  })
})

describe('lesson capture prompt markers', () => {
  test('postmortemPrompt preserves legacy markers and requires structured metadata', () => {
    const prompt = postmortemPrompt('Task', [], 'diff', 'reason', null)

    expect(prompt).toContain('CATEGORY:')
    expect(prompt).toContain('LESSON:')
    expect(prompt).toContain('ACTIONABLE: YES|NO')
    expect(prompt).toContain('SCOPE: GLOBAL|REPO')
    expect(prompt).toContain('STAGES:')
  })

  test('correctionPrompt preserves legacy markers and requires structured metadata', () => {
    const prompt = correctionPrompt('Task', 'agent diff', 'human diff', 'note', 'blocked')

    expect(prompt).toContain('CATEGORY:')
    expect(prompt).toContain('LESSON:')
    expect(prompt).toContain('ACTIONABLE: YES|NO')
    expect(prompt).toContain('SCOPE: GLOBAL|REPO')
    expect(prompt).toContain('STAGES:')
  })
})

describe('settled human answers', () => {
  const answers = '## Answer (2026-07-02T06:55:01.620Z)\nWe do want to sync inbound changes.'

  test('convergePrompt threads answers as settled decisions', () => {
    const prompt = convergePrompt('Task', [], 'review failed', answers)
    expect(prompt).toContain('## Human answers (settled decisions for this task)')
    expect(prompt).toContain('We do want to sync inbound changes.')
    expect(prompt).toContain('do not ASK_HUMAN it again')
    expect(convergePrompt('Task', [], 'review failed', null)).not.toContain('## Human answers')
  })

  test('consolidatePrompt and fixPrompt thread answers', () => {
    const consolidated = consolidatePrompt('Task', 'Plan', 'diff', [], null, null, answers)
    expect(consolidated).toContain('## Human answers (settled decisions for this task)')
    expect(consolidated).toContain('never demand it be reversed')

    const fix = fixPrompt(
      'Task',
      'Plan',
      'Failed',
      [],
      'diff',
      false,
      null,
      null,
      null,
      null,
      answers
    )
    expect(fix).toContain('## Human answers (settled decisions for this task)')
  })

  test('rescuePrompt threads answers', () => {
    const prompt = rescuePrompt({
      intent: 'Task',
      finalPlan: 'Plan',
      verify: null,
      currentDiff: 'diff',
      failures: [],
      latestFailure: 'review failed',
      guidance: null,
      answers,
    })
    expect(prompt).toContain('## Human answers (settled decisions for this task)')
    expect(prompt).toContain('never re-ask one of them')
  })

  test('blocking-capable review lenses thread answers as constraints', () => {
    const prompts = [
      reviewPrompt('Task', null, 'Plan', 'diff', null, null, answers),
      securityPrompt('Task', 'Plan', 'diff', null, null, answers),
      uxReviewPrompt('Task', 'Plan', 'diff', null, null, answers),
      deploySafetyPrompt('Task', 'Plan', 'diff', null, null, answers),
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain('## Human answers (settled decisions for this task)')
      expect(prompt).toContain('We do want to sync inbound changes.')
      expect(prompt).toContain('constraints, not review targets')
    }
    expect(reviewPrompt('Task', null, 'Plan', 'diff', null, null)).not.toContain('## Human answers')
  })
})

describe('prior review round memory', () => {
  const prior = '## Blocking\n1. `hour_slot.rb:547` — auth boundary\n\nVERDICT: FAIL'

  test('gating lenses thread the prior consolidated verdict on fix passes', () => {
    const prompts = [
      reviewPrompt('Task', null, 'Plan', 'diff', null, null, null, prior),
      securityPrompt('Task', 'Plan', 'diff', null, null, null, prior),
      uxReviewPrompt('Task', 'Plan', 'diff', null, null, null, prior),
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain('## Prior review round')
      expect(prompt).toContain('auth boundary')
      expect(prompt).toContain('REVERSAL:')
    }
    expect(reviewPrompt('Task', null, 'Plan', 'diff', null, null)).not.toContain(
      '## Prior review round'
    )
  })

  test('consolidatePrompt carries the reversal rule', () => {
    const prompt = consolidatePrompt('Task', 'Plan', 'diff', [], null, null)
    expect(prompt).toContain('reverses guidance a prior review round gave')
  })
})
