import { z } from 'zod'

export const RESEARCH_SCOUTS = [
  'code',
  'tests',
  'history',
  'external',
  'runtime',
  'data-model',
  'migration',
  'ui-map',
] as const

export const REVIEW_LENSES = ['correctness', 'security', 'risk', 'deploy', 'ux'] as const

export const ResearchScoutSchema = z.enum(RESEARCH_SCOUTS)
export const ReviewLensSchema = z.enum(REVIEW_LENSES)

export type ResearchScout = z.infer<typeof ResearchScoutSchema>
export type ReviewLens = z.infer<typeof ReviewLensSchema>

export type WorkforceEntry<K extends string> = {
  kind: K
  agent: string
  policies: string[]
  reason: string
}

export type WorkforcePlan = {
  research: Array<WorkforceEntry<ResearchScout>>
  review: Array<WorkforceEntry<ReviewLens>>
}

const ResearchEntrySchema = z.object({
  kind: ResearchScoutSchema,
  agent: z.string().min(1),
  policies: z.array(z.string().min(1)).default([]),
  reason: z.string().default(''),
})

const ReviewEntrySchema = z.object({
  kind: ReviewLensSchema,
  agent: z.string().min(1),
  policies: z.array(z.string().min(1)).default([]),
  reason: z.string().default(''),
})

const WorkforcePlanSchema = z.object({
  research: z.array(ResearchEntrySchema).default([]),
  review: z.array(ReviewEntrySchema).default([]),
})

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through: some agents wrap JSON in a fenced block despite instructions.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1]
  if (fenced) {
    return JSON.parse(fenced)
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('no JSON object found')
}

function uniqueByKind<K extends string>(
  entries: Array<WorkforceEntry<K>>
): Array<WorkforceEntry<K>> {
  const seen = new Set<string>()
  const unique: Array<WorkforceEntry<K>> = []
  for (const entry of entries) {
    if (seen.has(entry.kind)) {
      continue
    }
    seen.add(entry.kind)
    unique.push(entry)
  }
  return unique
}

export function parseWorkforcePlan(text: string): WorkforcePlan | null {
  try {
    const parsed = WorkforcePlanSchema.parse(extractJson(text))
    return {
      research: uniqueByKind(parsed.research),
      review: uniqueByKind(parsed.review),
    }
  } catch {
    return null
  }
}

export function serializeWorkforcePlan(plan: WorkforcePlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`
}
