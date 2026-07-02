import { describe, expect, test } from 'bun:test'
import { createAttentionTracker, type ParkedTask } from '../src/attention.ts'

function parked(id: string, status: ParkedTask['status']): ParkedTask {
  return { id, status }
}

describe('attention tracker', () => {
  test('alerts once per needs-input episode, then holds', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBeNull()
  })

  test('alerts once per blocked episode, then holds', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'blocked')], false)).toBe('blocked')
    expect(tracker.observeIdle([parked('A', 'blocked')], false)).toBeNull()
  })

  test('tracks episodes independently per (id, status)', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
    tracker.taskStarted('A')
    expect(tracker.observeIdle([parked('A', 'blocked')], false)).toBe('blocked')
  })

  test('a task answered and re-parked alerts fresh', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
    tracker.taskStarted('A')
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
  })

  test('one emit covers all currently parked pairs', () => {
    const tracker = createAttentionTracker()
    expect(
      tracker.observeIdle([parked('A', 'needs-input'), parked('B', 'needs-input')], false)
    ).toBe('needs-input')
    expect(
      tracker.observeIdle([parked('A', 'needs-input'), parked('B', 'needs-input')], false)
    ).toBeNull()
  })

  test('blocked wins priority among fresh pairs', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'blocked'), parked('B', 'needs-input')], false)).toBe(
      'blocked'
    )
  })

  test('a fresh needs-input beside a surfaced blocked emits needs-input', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'blocked')], false)).toBe('blocked')
    expect(tracker.observeIdle([parked('A', 'blocked'), parked('B', 'needs-input')], false)).toBe(
      'needs-input'
    )
  })

  test('holds through a drain leaving only surfaced tasks', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
    // The loop ran an unrelated task B (task start emitted 'none' externally).
    tracker.taskStarted('B')
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBeNull()
  })

  test('empty queue clears: done when all done, none otherwise', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([], true)).toBe('done')
    expect(tracker.observeIdle([], false)).toBe('none')
  })

  test('surfaced-only parked never yields done or none', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBeNull()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBeNull()
  })

  test('prunes stale marks so a reappearing pair is a new episode', () => {
    const tracker = createAttentionTracker()
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
    // Task closed out-of-band: the alert clears at the next poll.
    expect(tracker.observeIdle([], false)).toBe('none')
    expect(tracker.observeIdle([parked('A', 'needs-input')], false)).toBe('needs-input')
  })
})
