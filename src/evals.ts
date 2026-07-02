import { mkdir } from 'node:fs/promises'
import { runAgent } from './agents.ts'
import type { WorkContext } from './config.ts'
import { commitDiff, headSha, worktreeDiff } from './git.ts'
import { createGuidanceFromDistillation } from './guidance.ts'
import { appendCandidate } from './lessons.ts'
import { log } from './log.ts'
import { correctionPrompt } from './prompts.ts'
import { readIntent, type Task } from './task.ts'

// Capture every terminal task as a reproducible eval candidate, so a regression
// set accrues from real use instead of being hand-authored. Each case is
// self-contained (the diff is stored inline, since worktrees are short-lived and
// their branches may be deleted): re-run by checking out `baseCommit`, running
// factory on `spec`, and scoring against `verify` + the reference `diff`.
// Best-effort — a capture failure is logged and never affects the task.

type EvalOutcome = 'done' | 'blocked'

export async function captureCorrectionGuidance(
  ctx: WorkContext,
  input: {
    taskId: string
    category: string
    lesson: string
    distillation: string
  }
): Promise<'created' | 'duplicate' | 'not-actionable' | 'invalid'> {
  return createGuidanceFromDistillation(ctx, {
    source: { kind: 'correction', taskId: input.taskId, detail: input.category },
    text: input.lesson,
    distillation: input.distillation,
  })
}

export async function captureEvalCase(
  ctx: WorkContext,
  task: Task,
  outcome: EvalOutcome,
  reason?: string
): Promise<void> {
  if (!ctx.config.captureEvals) {
    return
  }
  try {
    const spec = await readIntent(task)
    // done → the committed diff, based on its parent. blocked → the uncommitted
    // attempt, based on current HEAD (the work was never committed).
    const committed = outcome === 'done' && task.meta.commit
    const baseCommit = committed ? `${task.meta.commit}^` : await headSha(ctx.root)
    const diff = committed
      ? await commitDiff(ctx.root, task.meta.commit ?? '')
      : await worktreeDiff(ctx.root)

    const record = {
      id: task.id,
      ts: new Date().toISOString(),
      outcome,
      reason: reason ?? null,
      worktree: ctx.root,
      baseCommit,
      verify: task.meta.verify,
      spec,
      diff,
    }
    const dir = `${ctx.repoStateDir}/eval-candidates`
    await mkdir(dir, { recursive: true })
    await Bun.write(
      `${dir}/${task.id}.${outcome}.${Date.now()}.json`,
      JSON.stringify(record, null, 2)
    )
    log.info(`captured eval candidate: ${task.id} (${outcome})`)
  } catch (err) {
    log.warn(`eval capture failed for ${task.id}: ${err instanceof Error ? err.message : err}`)
  }
}

// Record a human takeover of a blocked task: pair the agent's failed attempt (the
// saved diff.patch) with the human's correction (the current worktree) and distill
// the highest-signal lesson there is — what the agent should have done, with the
// right answer in hand. Writes a paired eval candidate + a lesson candidate.
export async function captureCorrection(ctx: WorkContext, task: Task, note: string): Promise<void> {
  const intent = await readIntent(task)
  const attempt = Bun.file(`${task.dir}/diff.patch`)
  const agentAttempt = (await attempt.exists()) ? await attempt.text() : ''
  const humanFix = await worktreeDiff(ctx.root)
  const reason = task.meta.note ?? 'blocked'

  let category = 'other'
  let lesson = note
  let distillation: string | null = null
  try {
    const out = await runAgent(ctx.agents.reviewer, {
      root: ctx.root,
      prompt: correctionPrompt(intent, agentAttempt, humanFix, note, reason),
      access: 'read',
    })
    distillation = out.text
    category = /CATEGORY:\s*(\w+)/i.exec(out.text)?.[1]?.toLowerCase() ?? 'other'
    lesson = /LESSON:\s*(.+)/i.exec(out.text)?.[1]?.trim() ?? note
  } catch (err) {
    log.warn(
      `correction distill failed for ${task.id}: ${err instanceof Error ? err.message : err}`
    )
  }

  if (ctx.config.captureEvals) {
    try {
      const record = {
        id: task.id,
        ts: new Date().toISOString(),
        outcome: 'corrected',
        reason,
        note: note || null,
        worktree: ctx.root,
        baseCommit: await headSha(ctx.root),
        verify: task.meta.verify,
        spec: intent,
        agentAttempt,
        humanFix,
      }
      const dir = `${ctx.repoStateDir}/eval-candidates`
      await mkdir(dir, { recursive: true })
      await Bun.write(
        `${dir}/${task.id}.corrected.${Date.now()}.json`,
        JSON.stringify(record, null, 2)
      )
    } catch (err) {
      log.warn(
        `correction eval capture failed for ${task.id}: ${err instanceof Error ? err.message : err}`
      )
    }
  }

  await appendCandidate(
    ctx,
    `correction · ${task.id} · [${category}] ${lesson || 'see eval candidate'}`
  )
  if (distillation && lesson) {
    try {
      const captured = await captureCorrectionGuidance(ctx, {
        taskId: task.id,
        category,
        lesson,
        distillation,
      })
      if (captured === 'invalid') {
        log.warn(`correction guidance metadata invalid for ${task.id}; kept raw candidate only`)
      }
    } catch (err) {
      log.warn(
        `correction guidance capture failed for ${task.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    }
  }
  log.info(`recorded correction for ${task.id} (${category})`)
}
