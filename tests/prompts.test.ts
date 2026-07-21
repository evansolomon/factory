import { describe, expect, test } from 'bun:test'
import {
  consolidatePrompt,
  convergePrompt,
  correctionPrompt,
  critiquePrompt,
  deploySafetyPrompt,
  executionShapeConfirmationPrompt,
  feedbackAnalysisPrompt,
  fixPrompt,
  implementPrompt,
  planPrompt,
  planRiskPrompt,
  postmortemPrompt,
  prototypePrompt,
  reconcilePrompt,
  remediatePrompt,
  replanPrompt,
  rescuePrompt,
  reviewPrompt,
  riskReviewPrompt,
  securityPrompt,
  triagePrompt,
  uxReviewPrompt,
} from '../src/prompts.ts'

const guidance = [
  '## Learned lessons (auto-applied; edit with `factory lessons edit <id>`)',
  '- [global abc123] Keep marker contracts stable.',
].join('\n')

describe('triage prompt implementer routing', () => {
  test('an empty pool keeps the five-marker contract with no IMPLEMENTER anywhere', () => {
    const prompt = triagePrompt('Fix the typo', null, [])

    expect(prompt).toContain(
      'Output ONLY these five final lines:\nAMBIGUITY: LOW|MEDIUM|HIGH\nCOUPLING: LOW|MEDIUM|HIGH\nCONSEQUENCE: LOW|MEDIUM|HIGH\nCOMPLEXITY: TRIVIAL|COMPLEX\nUSER-FACING: YES|NO'
    )
    expect(prompt).toContain('Classify the task below on five axes.')
    expect(prompt).not.toContain('IMPLEMENTER')
  })

  // Freeze the no-pool prompt: task-profile tuning is loop policy, so an
  // intentional edit must update this literal and run the replay gate.
  test('an empty pool renders the task-profile prompt byte-for-byte', () => {
    expect(
      triagePrompt('Fix the typo', null, [])
    ).toBe(`Classify the task below on five axes. Look at the repo briefly if it helps.

TASK PROFILE — three independent kinds of demand. Use LOW, MEDIUM, or HIGH:
- AMBIGUITY: uncertainty, novelty, missing information, or genuinely competing designs. This primarily calibrates research and planning.
- COUPLING: interacting components, boundaries, or invariants that must change together. A large mechanical edit can still be LOW or MEDIUM; count semantic interactions, not lines changed. This primarily calibrates implementation.
- CONSEQUENCE: blast radius and cost of being wrong, including security, durable data, compatibility, production impact, and rollback difficulty. This primarily calibrates review and verification.

COMPLEXITY — decides whether the full planning ensemble (research, two competing plans, cross-critique, reconcile, revise, select) runs before implementation. That ensemble costs real money and ~20+ minutes; it earns its cost ONLY when there are genuine design choices to compare. TRIVIAL tasks skip straight to implementation and are STILL fully reviewed by the expert panel and verified — trivial is a routing decision, not a safety decision.

Derive COMPLEXITY from the profile:
- TRIVIAL when AMBIGUITY is LOW, COUPLING is not HIGH, and CONSEQUENCE is not HIGH. A competent engineer would just start typing because the change is mechanical or obvious once stated.
- COMPLEX when AMBIGUITY is MEDIUM/HIGH, COUPLING is HIGH, or CONSEQUENCE is HIGH. A competent engineer should sketch a design, map interacting invariants, or explicitly derisk the work first.

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

Output ONLY these five final lines:
AMBIGUITY: LOW|MEDIUM|HIGH
COUPLING: LOW|MEDIUM|HIGH
CONSEQUENCE: LOW|MEDIUM|HIGH
COMPLEXITY: TRIVIAL|COMPLEX
USER-FACING: YES|NO`)
  })

  test('a non-empty pool lists entries and requests the sixth marker line', () => {
    const prompt = triagePrompt(
      'Fix the typo',
      null,
      [
        { name: 'quick', label: 'codex:gpt-5.4-mini', description: 'Small mechanical edits' },
        { name: 'local', label: 'claude', description: null },
      ],
      { label: 'codex:gpt-5.5', description: 'highly capable workhorse' }
    )

    expect(prompt).toContain('Classify the task below on six axes.')
    expect(prompt).toContain('- DEFAULT — codex:gpt-5.5: highly capable workhorse')
    expect(prompt).toContain('- quick — codex:gpt-5.4-mini: Small mechanical edits')
    expect(prompt).toContain('- local — claude')
    // Policy lives in the config-authored descriptions, not the template.
    expect(prompt).toContain("Each entry's description is its routing policy")
    expect(prompt).toContain('Do not hedge to DEFAULT')
    // The profile and route markers are still requested, plus the pool choice.
    expect(prompt).toContain(
      'Output ONLY these six final lines:\nAMBIGUITY: LOW|MEDIUM|HIGH\nCOUPLING: LOW|MEDIUM|HIGH\nCONSEQUENCE: LOW|MEDIUM|HIGH\nCOMPLEXITY: TRIVIAL|COMPLEX\nUSER-FACING: YES|NO\nIMPLEMENTER: quick|local|DEFAULT'
    )
  })

  test('an undescribed default implementer still gets a DEFAULT menu line', () => {
    const prompt = triagePrompt('Fix the typo', null, [
      { name: 'quick', label: 'codex:gpt-5.4-mini', description: null },
    ])

    expect(prompt).toContain('- DEFAULT — the default implementer')
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
    expect(prompt).toContain('`diff --git`')
    expect(prompt).not.toContain('```diff')
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

describe('structural recovery prompts', () => {
  test('plan risk classifies executable delivery shape', () => {
    const prompt = planRiskPrompt('Task', 'Plan')
    expect(prompt).toContain('EXECUTION: ATOMIC|STAGED')
    expect(prompt).toContain(
      'A prose cutting manifest does not make an aggregate implementation atomic'
    )
    expect(prompt).toContain('## Delivery units')
  })

  test('execution shape confirmation is independent and requires a concrete boundary', () => {
    const prompt = executionShapeConfirmationPrompt('Task', 'Plan', 'EXECUTION: STAGED')
    expect(prompt).toContain('Do not defer to the first assessment')
    expect(prompt).toContain('Multiple files or implementation steps do not make it staged')
    expect(prompt).toContain('EXECUTION: ATOMIC|STAGED')
  })

  test('rescue can select plan repair or decomposition', () => {
    const prompt = rescuePrompt({
      intent: 'Task',
      finalPlan: 'Plan',
      verify: null,
      diffPath: '/factory/task/diff.patch',
      failures: ['review: mutation boundary incomplete'],
      latestFailure: 'another mutation path bypasses invalidation',
      guidance: null,
    })
    expect(prompt).toContain('REPLAN')
    expect(prompt).toContain('DECOMPOSE')
    expect(prompt).toContain('/factory/task/diff.patch')
    expect(prompt).not.toContain('```diff')
  })

  test('replan preserves the goal and classifies the replacement plan', () => {
    const prompt = replanPrompt({
      intent: 'Improve affinity',
      finalPlan: 'Patch callbacks',
      diffPath: '/factory/task/diff.patch',
      failures: ['review: mutation boundary incomplete'],
      direction: 'Model the complete mutation boundary first.',
      answers: null,
    })
    expect(prompt).toContain("Preserve the task's settled goal")
    expect(prompt).toContain('what to keep, change, or remove')
    expect(prompt).toContain('EXECUTION: ATOMIC|STAGED')
  })
})

describe('implement stage delegation menu', () => {
  const delegates = [
    {
      name: 'quick',
      command: 'factory delegate --cli codex --model gpt-5.4-mini --usage-file /tmp/ledger.jsonl',
      description: 'small mechanical edits',
    },
    {
      name: 'haiku',
      command: 'factory delegate --cli claude --model haiku --usage-file /tmp/ledger.jsonl',
      description: null,
    },
  ]

  test('implementPrompt with no delegates contains no delegation section', () => {
    const prompt = implementPrompt('Task', 'Plan', null, false, null, null)

    expect(prompt).not.toContain('Delegation')
    expect(prompt).not.toContain('factory delegate')
  })

  test('implementPrompt lists each delegate command with its description', () => {
    const prompt = implementPrompt('Task', 'Plan', null, false, null, null, null, null, delegates)

    expect(prompt).toContain('## Delegation')
    expect(prompt).toContain(
      '- `factory delegate --cli codex --model gpt-5.4-mini --usage-file /tmp/ledger.jsonl` — quick: small mechanical edits'
    )
    expect(prompt).toContain(
      '- `factory delegate --cli claude --model haiku --usage-file /tmp/ledger.jsonl` — haiku'
    )
    expect(prompt).toContain('Each description says what its agent is suited for')
    expect(prompt).toContain('Use your own judgment')
    // The menu is curation, not a whitelist: any CLI-supported model works.
    expect(prompt).toContain('the entries above are the curated set, not a limit')
  })

  test('fixPrompt gets the same delegation menu', () => {
    const bare = fixPrompt('Task', 'Plan', 'Failed', [], 'diff', false, null, null)
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
      null,
      null,
      delegates
    )

    expect(bare).not.toContain('Delegation')
    expect(prompt).toContain('## Delegation')
    expect(prompt).toContain('quick: small mechanical edits')
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
      diffPath: '/factory/task/diff.patch',
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

describe('review diff evidence', () => {
  const diffPath = '/factory/tasks/example/diff.patch'
  const baselinePath = '/factory/tasks/example/baseline.patch'

  test('review stages reference saved patches instead of embedding their contents', () => {
    const prompts = [
      reviewPrompt('Task', null, 'Plan', diffPath, baselinePath, null),
      riskReviewPrompt('Task', 'Plan', diffPath, baselinePath),
      securityPrompt('Task', 'Plan', diffPath, baselinePath, null),
      deploySafetyPrompt('Task', 'Plan', diffPath, baselinePath, null),
      uxReviewPrompt('Task', 'Plan', diffPath, baselinePath, null),
      consolidatePrompt('Task', 'Plan', diffPath, [], baselinePath, null),
    ]

    for (const prompt of prompts) {
      expect(prompt).toContain(diffPath)
      expect(prompt).toContain(baselinePath)
      expect(prompt).toContain('git diff --stat HEAD')
      expect(prompt).not.toContain('```diff')
    }
  })

  test('fix rounds compare the current and previously reviewed snapshots', () => {
    const prompt = reviewPrompt(
      'Task',
      null,
      'Plan',
      diffPath,
      baselinePath,
      null,
      null,
      'prior verdict',
      '/factory/tasks/example/diff.previous.patch'
    )
    expect(prompt).toContain('diff.previous.patch')
    expect(prompt).toContain('Do not treat every fix round as an unrelated fresh audit')
  })

  test('consolidation requires a durable issue ledger and coverage record', () => {
    const prompt = consolidatePrompt('Task', 'Plan', diffPath, [], baselinePath, null)
    expect(prompt).toContain('## Issue ledger')
    expect(prompt).toContain('OPEN|RESOLVED|SUPERSEDED')
    expect(prompt).toContain('## Coverage')
  })
})
