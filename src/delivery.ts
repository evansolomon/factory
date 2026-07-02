import { mkdir, readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { WorkContext } from './config.ts'
import { globalSkillsDir } from './config.ts'
import type { Task } from './task.ts'

const DeliverySourceSchema = z.enum(['explicit', 'manual', 'selected', 'fallback'])
const DeliveryConfidenceSchema = z.enum(['low', 'medium', 'high'])

const DeliveryMetaSchema = {
  source: DeliverySourceSchema.default('selected'),
  confidence: DeliveryConfidenceSchema.nullable().default(null),
  reason: z.string().nullable().default(null),
}

export const TaskDeliverySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('pending') }),
  z.object({ mode: z.literal('none'), ...DeliveryMetaSchema }),
  z.object({ mode: z.literal('skill'), skill: z.string().min(1), ...DeliveryMetaSchema }),
  z.object({ mode: z.literal('policy'), policy: z.string().min(1), ...DeliveryMetaSchema }),
])
export type TaskDelivery = z.infer<typeof TaskDeliverySchema>

export type DeliveryAction = { skill: string } | { policy: string }

export type DeliverySkill = {
  name: string
  description: string | null
}

const DeliveryHistoryRecordSchema = z.object({
  taskId: z.string(),
  createdAt: z.string(),
  completedAt: z.string(),
  delivery: TaskDeliverySchema,
  outcome: z.enum(['done', 'failed']),
})
export type DeliveryHistoryRecord = z.infer<typeof DeliveryHistoryRecordSchema>

export function deliveryAction(delivery: TaskDelivery): DeliveryAction | null {
  switch (delivery.mode) {
    case 'pending':
    case 'none':
      return null
    case 'skill':
      return { skill: delivery.skill }
    case 'policy':
      return { policy: delivery.policy }
  }
}

export function deliveryLabel(delivery: TaskDelivery): string {
  switch (delivery.mode) {
    case 'pending':
      return 'pending'
    case 'none':
      return 'none'
    case 'skill':
      return `skill:${delivery.skill}`
    case 'policy':
      return `policy:${delivery.policy}`
  }
}

export function parseManualDelivery(value: string, skills: DeliverySkill[]): TaskDelivery {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('delivery value is required')
  }

  const lower = trimmed.toLowerCase()
  if (lower === 'none' || lower === 'disabled' || lower === 'off') {
    return {
      mode: 'none',
      source: 'manual',
      confidence: 'high',
      reason: 'User manually disabled delivery.',
    }
  }

  const explicit = extractDeliveryDirective(trimmed, skills).delivery
  if (explicit?.mode === 'skill') {
    return { ...explicit, source: 'manual', reason: `User manually requested ${trimmed}.` }
  }

  return {
    mode: 'policy',
    policy: trimmed,
    source: 'manual',
    confidence: 'high',
    reason: 'User manually set a delivery policy.',
  }
}

export function deliveryNeedsConfirmation(delivery: TaskDelivery): boolean {
  return (delivery.mode === 'skill' || delivery.mode === 'policy') && delivery.source === 'selected'
}

export function deliveryRecommendation(delivery: TaskDelivery): string | null {
  switch (delivery.mode) {
    case 'pending':
      return null
    case 'none':
      return 'none'
    case 'skill':
      return `$${delivery.skill}`
    case 'policy':
      return delivery.policy
  }
}

export function applyDeliveryConfirmation(input: {
  proposed: TaskDelivery
  answer: string | null
  skills: DeliverySkill[]
}): TaskDelivery | null {
  const answer = input.answer?.trim()
  if (!answer) {
    return null
  }

  const lower = answer.toLowerCase()
  if (lower === '(skipped)' || lower === '(no preference)') {
    return null
  }

  if (answer === deliveryRecommendation(input.proposed)) {
    return input.proposed
  }

  return parseManualDelivery(answer, input.skills)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractDeliveryDirective(
  intent: string,
  skills: DeliverySkill[]
): { intent: string; delivery: TaskDelivery | null } {
  for (const skill of skills) {
    const pattern = new RegExp(`(^|\\s)([$/])${escapeRegExp(skill.name)}(?=\\s|$)`, 'i')
    const match = pattern.exec(intent)
    if (!match) {
      continue
    }
    const stripped = intent
      .replace(pattern, '$1')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
    const sigil = match[2] ?? '$'
    return {
      intent: stripped || intent.trim(),
      delivery: {
        mode: 'skill',
        skill: skill.name,
        source: 'explicit',
        confidence: 'high',
        reason: `User explicitly requested ${sigil}${skill.name}.`,
      },
    }
  }
  return { intent, delivery: null }
}

function firstFrontmatterValue(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
  return match?.[1]?.trim() ?? null
}

async function skillsInDir(dir: string): Promise<DeliverySkill[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const skills: DeliverySkill[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const file = Bun.file(`${dir}/${entry.name}/SKILL.md`)
      if (!(await file.exists())) {
        continue
      }
      const text = await file.text()
      skills.push({
        name: firstFrontmatterValue(text, 'name') ?? entry.name,
        description: firstFrontmatterValue(text, 'description'),
      })
    }
    return skills
  } catch {
    return []
  }
}

// Repo skills (.skills/) plus GLOBAL skills ($FACTORY_HOME/skills/). Real usage
// showed 7 of 8 delivery selections choosing "none" solely because no skills
// were registered in that repo — stranding 33-hour tasks at unadvertised local
// commits. Machine-wide ship/pr skills make delivery the default everywhere;
// a repo skill with the same name overrides the global one.
export async function listDeliverySkills(root: string): Promise<DeliverySkill[]> {
  const repo = await skillsInDir(`${root}/.skills`)
  const global = await skillsInDir(globalSkillsDir())
  const names = new Set(repo.map((s) => s.name.toLowerCase()))
  const merged = [...repo, ...global.filter((s) => !names.has(s.name.toLowerCase()))]
  return merged.sort((a, b) => a.name.localeCompare(b.name))
}

function historyPath(ctx: WorkContext): string {
  return `${ctx.repoStateDir}/delivery-history.jsonl`
}

export async function readDeliveryHistory(
  ctx: WorkContext,
  limit = 20
): Promise<DeliveryHistoryRecord[]> {
  const file = Bun.file(historyPath(ctx))
  if (!(await file.exists())) {
    return []
  }
  const records: DeliveryHistoryRecord[] = []
  for (const line of (await file.text()).split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      records.push(DeliveryHistoryRecordSchema.parse(JSON.parse(line)))
    } catch {}
  }
  return records.slice(-limit)
}

export async function appendDeliveryHistory(
  ctx: WorkContext,
  task: Task,
  outcome: 'done' | 'failed'
): Promise<void> {
  const record: DeliveryHistoryRecord = {
    taskId: task.id,
    createdAt: task.meta.createdAt,
    completedAt: new Date().toISOString(),
    delivery: task.meta.delivery,
    outcome,
  }
  const path = historyPath(ctx)
  await mkdir(ctx.repoStateDir, { recursive: true })
  const file = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : ''
  await Bun.write(path, `${existing}${JSON.stringify(record)}\n`)
}

export function formatDeliveryHistory(records: DeliveryHistoryRecord[]): string {
  if (records.length === 0) {
    return '(none)'
  }
  return records
    .map(
      (record) =>
        `- ${record.completedAt}: ${record.taskId} delivery=${deliveryLabel(record.delivery)} source=${
          record.delivery.mode === 'pending' ? 'pending' : record.delivery.source
        } outcome=${record.outcome}`
    )
    .join('\n')
}
