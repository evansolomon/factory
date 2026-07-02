import { describe, expect, test } from 'bun:test'
import {
  applyDeliveryConfirmation,
  deliveryAction,
  deliveryLabel,
  deliveryNeedsConfirmation,
  deliveryRecommendation,
  extractDeliveryDirective,
  parseManualDelivery,
  type TaskDelivery,
} from '../src/delivery.ts'
import { parseDeliverySelection } from '../src/markers.ts'

describe('delivery decisions', () => {
  test('extracts explicit skill directives from task intent', () => {
    const result = extractDeliveryDirective('Fix release workflow $ship', [
      { name: 'ship', description: null },
    ])

    expect(result.intent).toBe('Fix release workflow')
    expect(result.delivery).toEqual({
      mode: 'skill',
      skill: 'ship',
      source: 'explicit',
      confidence: 'high',
      reason: 'User explicitly requested $ship.',
    })
  })

  test('labels task delivery states', () => {
    expect(deliveryLabel({ mode: 'pending' })).toBe('pending')
    expect(
      deliveryLabel({
        mode: 'none',
        source: 'selected',
        confidence: 'medium',
        reason: 'Docs-only task.',
      })
    ).toBe('none')
    expect(
      deliveryLabel({
        mode: 'skill',
        skill: 'ship',
        source: 'selected',
        confidence: 'high',
        reason: 'User asked to ship.',
      })
    ).toBe('skill:ship')
    expect(
      deliveryLabel({
        mode: 'policy',
        policy: 'Open a PR and do not merge',
        source: 'manual',
        confidence: 'high',
        reason: 'Manual policy.',
      })
    ).toBe('policy:Open a PR and do not merge')
  })

  test('converts deliverable modes into ship actions', () => {
    expect(
      deliveryAction({
        mode: 'skill',
        skill: 'ship',
        source: 'selected',
        confidence: 'high',
        reason: 'User asked to ship.',
      })
    ).toEqual({ skill: 'ship' })
    expect(deliveryAction({ mode: 'pending' })).toBeNull()
  })

  test('parses manual delivery values', () => {
    const skills = [
      { name: 'pr', description: null },
      { name: 'ship', description: null },
    ]

    expect(parseManualDelivery('none', skills)).toEqual({
      mode: 'none',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually disabled delivery.',
    })
    expect(parseManualDelivery('/ship', skills)).toEqual({
      mode: 'skill',
      skill: 'ship',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually requested /ship.',
    })
    expect(parseManualDelivery('pr', skills)).toEqual({
      mode: 'skill',
      skill: 'pr',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually requested pr.',
    })
    expect(parseManualDelivery('$missing', skills)).toEqual({
      mode: 'policy',
      policy: '$missing',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually set a delivery policy.',
    })
    expect(parseManualDelivery('Open a PR and wait for CI', skills)).toEqual({
      mode: 'policy',
      policy: 'Open a PR and wait for CI',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually set a delivery policy.',
    })
    expect(() => parseManualDelivery('', skills)).toThrow('delivery value is required')
  })

  test('requires confirmation only for selected side-effecting delivery', () => {
    expect(
      deliveryNeedsConfirmation({
        mode: 'skill',
        skill: 'ship',
        source: 'selected',
        confidence: 'high',
        reason: 'History matches.',
      })
    ).toBe(true)
    expect(
      deliveryNeedsConfirmation({
        mode: 'policy',
        policy: 'Open a PR.',
        source: 'selected',
        confidence: 'medium',
        reason: 'Task asked for review.',
      })
    ).toBe(true)
    expect(
      deliveryNeedsConfirmation({
        mode: 'skill',
        skill: 'ship',
        source: 'explicit',
        confidence: 'high',
        reason: 'User asked.',
      })
    ).toBe(false)
    expect(
      deliveryNeedsConfirmation({
        mode: 'none',
        source: 'selected',
        confidence: 'low',
        reason: 'No delivery needed.',
      })
    ).toBe(false)
  })

  test('recommends accepted delivery answer values', () => {
    expect(deliveryRecommendation({ mode: 'pending' })).toBeNull()
    expect(
      deliveryRecommendation({
        mode: 'none',
        source: 'selected',
        confidence: 'low',
        reason: null,
      })
    ).toBe('none')
    expect(
      deliveryRecommendation({
        mode: 'skill',
        skill: 'ship',
        source: 'selected',
        confidence: 'high',
        reason: null,
      })
    ).toBe('$ship')
    expect(
      deliveryRecommendation({
        mode: 'policy',
        policy: 'Open a PR and do not merge.',
        source: 'selected',
        confidence: 'medium',
        reason: null,
      })
    ).toBe('Open a PR and do not merge.')
  })

  test('applies delivery confirmation without authorizing non-answers', () => {
    const proposed: TaskDelivery = {
      mode: 'skill',
      skill: 'ship',
      source: 'selected',
      confidence: 'high',
      reason: 'Similar tasks shipped.',
    }
    const skills = [{ name: 'ship', description: null }]

    expect(applyDeliveryConfirmation({ proposed, answer: '$ship', skills })).toEqual(proposed)
    expect(applyDeliveryConfirmation({ proposed, answer: 'none', skills })).toEqual({
      mode: 'none',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually disabled delivery.',
    })
    expect(applyDeliveryConfirmation({ proposed, answer: '/ship', skills })).toEqual({
      mode: 'skill',
      skill: 'ship',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually requested /ship.',
    })
    expect(
      applyDeliveryConfirmation({ proposed, answer: 'Wait for release approval.', skills })
    ).toEqual({
      mode: 'policy',
      policy: 'Wait for release approval.',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually set a delivery policy.',
    })
    expect(applyDeliveryConfirmation({ proposed, answer: null, skills })).toBeNull()
    expect(applyDeliveryConfirmation({ proposed, answer: '  ', skills })).toBeNull()
    expect(applyDeliveryConfirmation({ proposed, answer: '(skipped)', skills })).toBeNull()
    expect(applyDeliveryConfirmation({ proposed, answer: '(no preference)', skills })).toBeNull()
  })
})

describe('parseDeliverySelection', () => {
  test('parses known skills', () => {
    const parsed = parseDeliverySelection(
      ['DELIVERY: SKILL ship', 'CONFIDENCE: high', 'REASON: User asked to ship it.'].join('\n'),
      ['ship']
    )

    expect(parsed.delivery).toEqual({
      mode: 'skill',
      skill: 'ship',
      source: 'selected',
      confidence: 'high',
      reason: 'User asked to ship it.',
    })
  })

  test('falls back to none for unsupported selector output', () => {
    const parsed = parseDeliverySelection('DELIVERY: SKILL missing', ['ship'])

    expect(parsed.delivery.mode).toBe('none')
    expect(parsed.delivery.source).toBe('fallback')
  })
})

import { mkdir as mkdirSkills, mkdtemp } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { listDeliverySkills } from '../src/delivery.ts'

describe('delivery skill layers', () => {
  test('repo .skills > repo-keyed skills > global, merged by name', async () => {
    const previous = process.env['FACTORY_HOME']
    const home = await mkdtemp(`${osTmpdir()}/factory-skills-home-`)
    process.env['FACTORY_HOME'] = home
    try {
      const root = await mkdtemp(`${osTmpdir()}/factory-skills-root-`)
      const repoState = await mkdtemp(`${osTmpdir()}/factory-skills-state-`)
      const write = async (dir: string, name: string, desc: string) => {
        await mkdirSkills(`${dir}/${name}`, { recursive: true })
        await Bun.write(
          `${dir}/${name}/SKILL.md`,
          `---\nname: ${name}\ndescription: ${desc}\n---\n`
        )
      }
      await write(`${root}/.skills`, 'ship', 'repo ship')
      await write(`${repoState}/skills`, 'ship', 'repo-keyed ship (shadowed)')
      await write(`${repoState}/skills`, 'pr', 'repo-keyed pr')
      await write(`${home}/skills`, 'pr', 'global pr (shadowed)')
      await write(`${home}/skills`, 'deploy', 'global deploy')

      const skills = await listDeliverySkills(root, repoState)

      expect(skills.map((s) => `${s.name}:${s.description}`)).toEqual([
        'deploy:global deploy',
        'pr:repo-keyed pr',
        'ship:repo ship',
      ])
    } finally {
      if (previous === undefined) {
        delete process.env['FACTORY_HOME']
      } else {
        process.env['FACTORY_HOME'] = previous
      }
    }
  })
})
