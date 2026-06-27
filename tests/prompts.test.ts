import { describe, expect, test } from 'bun:test'
import {
  consolidatePrompt,
  correctionPrompt,
  critiquePrompt,
  deploySafetyPrompt,
  feedbackAnalysisPrompt,
  fixPrompt,
  implementPrompt,
  planPrompt,
  postmortemPrompt,
  reconcilePrompt,
  remediatePrompt,
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
