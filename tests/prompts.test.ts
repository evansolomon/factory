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
  uxReviewPrompt,
} from '../src/prompts.ts'

const guidance = [
  '## Learned lessons (auto-applied; edit with `factory lessons edit <id>`)',
  '- [global abc123] Keep marker contracts stable.',
].join('\n')

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
})
