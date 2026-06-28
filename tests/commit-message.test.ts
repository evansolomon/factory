import { describe, expect, test } from 'bun:test'
import { cleanCommitMessage, fallbackCommitMessage } from '../src/commit-message.ts'

describe('commit messages', () => {
  test('fallback skips generic markdown headings', () => {
    expect(
      fallbackCommitMessage(`# Problem

The task should use repo-style commit messages.`)
    ).toBe('The task should use repo-style commit messages.')
  })

  test('fallback ignores empty generic plan boilerplate', () => {
    expect(
      fallbackCommitMessage(`## Problem

## Plan`)
    ).toBe('Apply task')
  })

  test('cleaned model output removes transport labels but preserves style punctuation', () => {
    expect(
      cleanCommitMessage(
        `Subject: wt add: base new worktrees on origin/master.

This changes the worktree base.`,
        'Apply task'
      )
    ).toBe('wt add: base new worktrees on origin/master.')
  })

  test('cleaned model output falls back for generic headings', () => {
    expect(cleanCommitMessage('## Summary', 'Apply task')).toBe('Apply task')
  })

  test('cleaned model output does not silently accept bullets', () => {
    expect(cleanCommitMessage('- wt add: base new worktrees on origin/master', 'Apply task')).toBe(
      'Apply task'
    )
  })
})
