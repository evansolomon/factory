import { describe, expect, test } from 'bun:test'
import { isDeliveryConfirmationPrompt } from '../src/prompt.ts'
import type { Task } from '../src/task.ts'

function taskWithProposal(): Task {
  return {
    id: 'confirm-delivery',
    dir: '/tmp/confirm-delivery',
    meta: {
      id: 'confirm-delivery',
      slug: 'confirm-delivery',
      status: 'needs-input',
      verify: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      commit: null,
      commitStartedAt: null,
      note: null,
      sharpen: 'done',
      resume: true,
      resumeNote: null,
      resumeKind: null,
      retryAt: null,
      autoRetries: 0,
      complexity: null,
      taskProfile: null,
      implementer: null,
      delivery: { mode: 'pending' },
      deliveryProposal: {
        mode: 'skill',
        skill: 'ship',
        source: 'selected',
        confidence: 'high',
        reason: 'Similar tasks shipped.',
      },
      deliveryProposalAt: '2026-01-01T00:00:00.000Z',
      userFacing: undefined,
      shipBranch: null,
      shipUrl: null,
      harvestedAt: null,
      questionRounds: 0,
      autoAcceptedRounds: 0,
      feedbackCount: 0,
      feedbackConsumed: 0,
      feedbackSourceTaskId: null,
    },
  }
}

describe('prompt delivery confirmation', () => {
  test('defers skip only for formatted delivery-confirmation prompts', () => {
    const task = taskWithProposal()

    expect(isDeliveryConfirmationPrompt(task, true)).toBe(true)
    expect(isDeliveryConfirmationPrompt(task, false)).toBe(false)

    task.meta.deliveryProposal = undefined
    task.meta.deliveryProposalAt = null
    expect(isDeliveryConfirmationPrompt(task, true)).toBe(false)
  })
})
