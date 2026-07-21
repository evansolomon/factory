import { createHash } from 'node:crypto'
import { z } from 'zod'

const UnitSchema = z.object({
  name: z.string().min(1).max(80),
  intent: z.string().min(1),
  verify: z.string().min(1).nullable(),
})

export const DecompositionSchema = z
  .object({
    summary: z.string().min(1),
    units: z.array(UnitSchema).min(2).max(20),
  })
  .superRefine((value, ctx) => {
    const names = new Set<string>()
    for (const [index, unit] of value.units.entries()) {
      const name = unit.name.trim().toLowerCase()
      if (names.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', index, 'name'],
          message: 'unit names must be unique',
        })
      }
      names.add(name)
    }
  })

export type Decomposition = z.infer<typeof DecompositionSchema>

export function parseDecomposition(text: string): Decomposition | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text)?.[1]
  const candidate = fenced ?? text.trim()
  try {
    const parsed = DecompositionSchema.safeParse(JSON.parse(candidate))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function decompositionChainId(taskId: string, plan: string): string {
  const hash = createHash('sha256').update(plan).digest('hex').slice(0, 8)
  return `${taskId}-${hash}`
}

export function renderDecomposition(decomposition: Decomposition, chainId: string): string {
  const units = decomposition.units.flatMap((unit, index) => [
    `## ${index + 1}. ${unit.name}`,
    '',
    unit.intent.trim(),
    '',
    `Verify: ${unit.verify ? `\`${unit.verify}\`` : 'derive the narrow repository gate'}`,
    '',
  ])
  return [
    '# Autonomous staged delivery',
    '',
    `Chain: \`${chainId}\``,
    '',
    decomposition.summary.trim(),
    '',
    ...units,
  ].join('\n')
}

export function stagedUnitIntent(input: {
  parentTaskId: string
  sourceWorktree: string
  chainId: string
  unit: Decomposition['units'][number]
  index: number
  count: number
}): string {
  return `# Staged delivery unit ${input.index + 1} of ${input.count}: ${input.unit.name}

Complete this unit autonomously as one independently reviewable, verifiable, and deliverable change. Factory dispatches this chain serially, so all earlier units have completed before this workstream starts. Finish delivery before returning success so the next unit is not released early.

Parent task: ${input.parentTaskId}
Delivery chain: ${input.chainId}
Reference worktree: ${input.sourceWorktree}

The reference worktree may contain an aggregate implementation. Treat it as read-only evidence: inspect and selectively port relevant work, but validate this unit against your clean worktree and do not broaden into later units.

## Unit outcome

${input.unit.intent.trim()}`
}
