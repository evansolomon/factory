import { z } from 'zod'

export const OnCompleteSchema = z.union([
  z.object({ skill: z.string().min(1) }),
  z.object({ policy: z.string().min(1) }),
])
export type OnComplete = z.infer<typeof OnCompleteSchema>

export const TaskOnCompleteSchema = z
  .discriminatedUnion('mode', [
    z.object({ mode: z.literal('inherit') }),
    z.object({ mode: z.literal('disabled') }),
    z.object({ mode: z.literal('policy'), policy: z.string().min(1) }),
  ])
  .default({ mode: 'inherit' })
export type TaskOnComplete = z.infer<typeof TaskOnCompleteSchema>

export function resolveOnComplete(
  taskOverride: TaskOnComplete,
  configured: OnComplete | null
): OnComplete | null {
  switch (taskOverride.mode) {
    case 'inherit':
      return configured
    case 'disabled':
      return null
    case 'policy':
      return { policy: taskOverride.policy }
  }
}

export function onCompleteLabel(onComplete: OnComplete | null): string {
  if (!onComplete) {
    return 'disabled'
  }
  return 'skill' in onComplete ? `skill:${onComplete.skill}` : `policy:${onComplete.policy}`
}

export function taskOnCompleteLabel(onComplete: TaskOnComplete): string {
  switch (onComplete.mode) {
    case 'inherit':
      return 'inherit'
    case 'disabled':
      return 'disabled'
    case 'policy':
      return `policy:${onComplete.policy}`
  }
}
