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
