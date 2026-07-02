import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { guidanceSimilarity } from './guidance.ts'
import { log } from './log.ts'
import { parseFormattedQuestions } from './sharpen.ts'

// Question-bar telemetry: every answered question round is classified as
// "accepted the recommendations" or "overrode them", and the rolling accept
// rate is fed back into the asking prompts as calibration. Real usage showed
// ~a third of interruptions were verbatim rubber-stamps — the bar tunes itself
// from measured behavior instead of a hand-tweaked prompt constant.

export type AnswerVerdict = 'accept' | 'override' | 'auto-accept' | 'unclear'

const ACCEPT_PATTERNS = [
  /\b(go|proceed|agree|continue)\s+with\b.*\brecommend/i,
  /\brecommended answers?\b/i,
  /\byour recommendations?\b/i,
  /^(yes|ok|okay|sounds good|lgtm|do it|proceed|accept(ed)?|all recommended)[.! ]*$/i,
]

// Classify a human answer against the question round it responds to. Heuristic
// and deliberately conservative: only clear acceptance phrasings or an answer
// that essentially restates a recommendation count as "accept"; everything
// substantive counts as "override" (the valuable kind of interruption).
export function classifyAnswer(questionsText: string, answer: string): AnswerVerdict {
  const trimmed = answer.trim()
  if (!trimmed) {
    return 'unclear'
  }
  if (ACCEPT_PATTERNS.some((p) => p.test(trimmed))) {
    return 'accept'
  }
  const { questions } = parseFormattedQuestions(questionsText)
  const recs = questions.map((q) => q.rec).filter((r) => r.length > 0)
  if (recs.length > 0 && recs.some((rec) => guidanceSimilarity(rec, trimmed) >= 0.6)) {
    return 'accept'
  }
  return 'override'
}

const StatEntrySchema = z.object({
  ts: z.string(),
  task: z.string(),
  verdict: z.enum(['accept', 'override', 'auto-accept', 'unclear']),
})
type StatEntry = z.infer<typeof StatEntrySchema>

function statsPath(repoStateDir: string): string {
  return `${repoStateDir}/question-stats.jsonl`
}

export async function recordAnswerVerdict(
  repoStateDir: string,
  task: string,
  verdict: AnswerVerdict
): Promise<void> {
  try {
    const path = statsPath(repoStateDir)
    await mkdir(dirname(path), { recursive: true })
    const file = Bun.file(path)
    const existing = (await file.exists()) ? await file.text() : ''
    const entry: StatEntry = { ts: new Date().toISOString(), task, verdict }
    await Bun.write(path, `${existing}${JSON.stringify(entry)}\n`)
  } catch (err) {
    log.warn(`question stats append failed: ${err instanceof Error ? err.message : err}`)
  }
}

export type AskStats = { rounds: number; accepts: number; overrides: number }

export async function readAskStats(repoStateDir: string, limit: number = 30): Promise<AskStats> {
  const empty: AskStats = { rounds: 0, accepts: 0, overrides: 0 }
  try {
    const file = Bun.file(statsPath(repoStateDir))
    if (!(await file.exists())) {
      return empty
    }
    const entries: StatEntry[] = []
    for (const line of (await file.text()).split('\n')) {
      if (!line.trim()) {
        continue
      }
      const parsed = StatEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) {
        entries.push(parsed.data)
      }
    }
    const recent = entries.slice(-limit)
    return {
      rounds: recent.length,
      accepts: recent.filter((e) => e.verdict === 'accept' || e.verdict === 'auto-accept').length,
      overrides: recent.filter((e) => e.verdict === 'override').length,
    }
  } catch {
    return empty
  }
}

// The calibration block injected into the asking prompts (sharpen, reconcile).
// Only rendered once there is enough signal to mean something.
export function renderAskCalibration(stats: AskStats): string | null {
  if (stats.rounds < 5) {
    return null
  }
  const acceptRate = Math.round((stats.accepts / stats.rounds) * 100)
  const overrideRate = Math.round((stats.overrides / stats.rounds) * 100)
  const steer =
    acceptRate >= 70
      ? 'Most interruptions here get rubber-stamped: raise your asking bar — state the recommendation as an explicit assumption and PROCEED unless the decision is genuinely unguessable or high-stakes.'
      : overrideRate >= 50
        ? 'Answers here frequently override recommendations: your recommendations are missing real context — keep asking when a genuine fork exists, and invest more in grounding each recommendation.'
        : 'The current asking bar looks roughly calibrated; keep asking only genuine forks, each with a concrete recommendation.'
  return [
    '## Interruption calibration (measured, this repo)',
    `Of the last ${stats.rounds} answered question rounds, ${acceptRate}% accepted the ` +
      `recommendations as-is and ${overrideRate}% overrode them. ${steer}`,
  ].join('\n')
}
