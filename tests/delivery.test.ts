import { describe, expect, test } from 'bun:test'
import { deliveryAction, deliveryLabel, extractDeliveryDirective } from '../src/delivery.ts'
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
