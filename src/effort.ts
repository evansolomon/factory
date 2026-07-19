import { z } from 'zod'

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh'])
export type Effort = z.infer<typeof EffortSchema>

export const ModelEffortSchema = z.enum(['minimal', ...EffortSchema.options])
export type ModelEffort = z.infer<typeof ModelEffortSchema>

export const DemandLevelSchema = z.enum(['low', 'medium', 'high'])
export type DemandLevel = z.infer<typeof DemandLevelSchema>

export const TaskProfileSchema = z.object({
  ambiguity: DemandLevelSchema,
  coupling: DemandLevelSchema,
  consequence: DemandLevelSchema,
})
export type TaskProfile = z.infer<typeof TaskProfileSchema>

const LEVEL: Record<DemandLevel, number> = { low: 0, medium: 1, high: 2 }
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh']

function highest(...levels: DemandLevel[]): DemandLevel {
  return levels.reduce((best, level) => (LEVEL[level] > LEVEL[best] ? level : best), 'low')
}

function demandEffort(...levels: DemandLevel[]): Effort {
  return highest(...levels) === 'high' ? 'high' : 'medium'
}

function raise(effort: Effort, steps: number = 1): Effort {
  return EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + steps)] ?? effort
}

export function defaultTaskProfile(complexity: 'trivial' | 'complex' | null): TaskProfile {
  const level = complexity === 'trivial' ? 'low' : 'medium'
  return { ambiguity: level, coupling: level, consequence: level }
}

// Complexity remains a routing decision, not a scalar measure of difficulty.
// Medium coupling alone can still be a large mechanical change; ambiguity or
// high coupling/consequence is what earns the full planning ensemble.
export function profileIsTrivial(profile: TaskProfile): boolean {
  return (
    profile.ambiguity === 'low' && profile.coupling !== 'high' && profile.consequence !== 'high'
  )
}

export type EffortDecision = {
  effort: Effort
  reason: string
}

const CLERICAL_STAGES = new Set(['name', 'commit-message', 'deck'])
const FAILURE_STAGES = new Set([
  'implement',
  'correctness',
  'security',
  'risk',
  'deploy',
  'ux',
  'consolidate',
  'quickfix',
  'converge',
  'remediate',
])
const PLAN_RISK_STAGES = new Set([
  'prototype',
  'implement',
  'correctness',
  'security',
  'risk',
  'deploy',
  'ux',
  'consolidate',
  'quickfix',
  'ship',
])

function stageBaseEffort(stage: string, profile: TaskProfile): EffortDecision {
  if (CLERICAL_STAGES.has(stage)) {
    return { effort: 'low', reason: 'clerical stage' }
  }
  if (stage === 'triage') {
    return { effort: 'medium', reason: 'stable bootstrap classification' }
  }
  if (stage === 'rescue') {
    return { effort: 'xhigh', reason: 'last-chance recovery' }
  }
  if (stage === 'postmortem' || stage === 'converge' || stage === 'remediate') {
    return { effort: 'high', reason: 'failure diagnosis' }
  }
  if (stage === 'ship') {
    return { effort: 'high', reason: 'externally visible delivery' }
  }
  if (stage === 'quickfix') {
    return { effort: 'medium', reason: 'bounded advisory fixes' }
  }
  if (stage === 'feedback' || stage === 'delivery-select') {
    return { effort: 'medium', reason: 'bounded judgment' }
  }
  if (
    stage === 'workforce' ||
    stage === 'research' ||
    stage.startsWith('research.') ||
    stage === 'plan' ||
    stage === 'critique' ||
    stage === 'reconcile' ||
    stage === 'revise' ||
    stage === 'select' ||
    stage === 'sharpen' ||
    stage === 'sharpen-review'
  ) {
    const demand = highest(profile.ambiguity, profile.coupling)
    return {
      effort: demandEffort(demand),
      reason: `${demand} ambiguity/coupling`,
    }
  }
  if (stage === 'prototype') {
    const demand = highest(profile.ambiguity, profile.coupling, profile.consequence)
    return { effort: demandEffort(demand), reason: `${demand} overall demand` }
  }
  if (stage === 'implement') {
    const demand = highest(profile.coupling, profile.consequence)
    return { effort: demandEffort(demand), reason: `${demand} coupling/consequence` }
  }
  if (
    stage === 'correctness' ||
    stage === 'security' ||
    stage === 'risk' ||
    stage === 'deploy' ||
    stage === 'ux' ||
    stage === 'consolidate'
  ) {
    const demand = highest(profile.coupling, profile.consequence)
    return { effort: demandEffort(demand), reason: `${demand} review demand` }
  }
  return { effort: 'medium', reason: 'default stage baseline' }
}

export function resolveStageEffort(input: {
  stage: string
  profile: TaskProfile
  planRisk: number | null
  attempt: number
}): EffortDecision {
  const base = stageBaseEffort(input.stage, input.profile)
  let effort = base.effort
  const reasons = [base.reason]

  if (input.planRisk !== null && PLAN_RISK_STAGES.has(input.stage) && input.planRisk >= 6) {
    const steps = input.planRisk >= 9 ? 2 : 1
    effort = raise(effort, steps)
    reasons.push(`plan risk ${input.planRisk}`)
  }

  if (input.attempt > 0 && FAILURE_STAGES.has(input.stage)) {
    effort = raise(effort, input.attempt >= 2 ? 2 : 1)
    reasons.push(`fix attempt ${input.attempt}`)
  }

  return { effort, reason: reasons.join('; ') }
}
