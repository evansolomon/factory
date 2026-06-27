# Plan: Confirm Auto-Selected Side-Effecting Delivery

## Intent

Add a confirmation gate after delivery inference and before implementation. If factory auto-selects a side-effecting delivery (`skill` or `policy` with `source: selected`), keep the effective task delivery pending, ask through the existing `needs-input` path, and resume only after the human confirms or overrides the choice.

Do not change delivery inference ranking, `$pr` / `$ship` behavior, manual `factory delivery`, or the existing prompt system.

## Design

Use `needs-input` as the only interaction path.

When the selector proposes a side-effecting delivery, store the proposal separately as task metadata and leave `meta.delivery` as `pending`. This avoids making an unconfirmed side effect look effective in `factory show`, while preserving the structured selector output across resume.

Add:

```ts
meta.deliveryProposal?: TaskDelivery
meta.userFacing?: boolean
```

`deliveryProposal` is cleared once confirmed or overridden. `userFacing` is persisted because this new pause happens before implementation, when resume cannot safely infer UX relevance from a diff.

## Delivery Rules

Prompt only when all are true:

- `meta.delivery.mode === 'pending'`
- selector result is `mode: 'skill'` or `mode: 'policy'`
- selector result has `source: 'selected'`

Do not prompt for:

- explicit `$pr`, `/pr`, `$ship`, `/ship`
- manual `factory delivery ...`
- selector result `none`
- fallback delivery
- already-confirmed delivery

## Answer Semantics

Accepted confirmation answers:

- Enter in the inline formatted prompt accepts the recommendation
- recommended value, such as `$ship`, confirms the proposal
- `none`, `disabled`, or `off` disables delivery as manual `none`
- `$pr`, `/pr`, `$ship`, `/ship` selects that known skill as manual delivery
- any other non-empty text becomes a manual delivery policy

Non-answers must never authorize side effects:

- missing answer
- blank non-interactive answer
- `(skipped)`
- `(no preference)`

For this delivery-confirmation question only, inline `/skip` should behave like defer: keep the task parked as `needs-input`, do not append an approving answer, and avoid an immediate re-prompt loop.

## Implementation

### `src/delivery.ts`

Move the current CLI-only manual parser into the delivery domain:

```ts
export function parseManualDelivery(value: string, skills: DeliverySkill[]): TaskDelivery
```

Preserve current behavior:

- `none`, `disabled`, `off` -> manual `none`
- known sigiled skill -> manual `skill`
- unknown sigiled value -> manual `policy`
- free text -> manual `policy`
- empty -> throw

Add pure helpers:

```ts
export function deliveryNeedsConfirmation(delivery: TaskDelivery): boolean
export function deliveryRecommendation(delivery: TaskDelivery): string | null
export function applyDeliveryConfirmation(input: {
  proposed: TaskDelivery
  answer: string | null
  skills: DeliverySkill[]
}): TaskDelivery | null
```

Confirmation keeps the original selected delivery when the answer exactly accepts the recommendation, preserving selector reason/history. Overrides use `parseManualDelivery`.

### `src/task.ts`

Extend metadata schema with:

```ts
deliveryProposal: TaskDeliverySchema.optional()
userFacing: z.boolean().optional()
```

Add an artifact parser near answer helpers:

```ts
export function latestAnswerValue(answers: string): string | null
```

It should read the latest `## Answer (...)` block, extract the final formatted `A:` value when present, otherwise return the raw latest answer body. Return `null` for no usable answer.

### `src/cli.ts`

Remove the local manual delivery parser and call `parseManualDelivery(...)` from `src/delivery.ts`.

No behavior change for `factory delivery`.

### `src/conductor.ts`

Update `selectTaskDelivery(...)` to return `Promise<TaskOutcome | null>` and use the existing `needsInput(...)` helper.

Flow:

1. Refresh metadata.
2. If `meta.deliveryProposal` exists:
   - read latest answer
   - apply confirmation
   - if unresolved, re-park through `needsInput(...)`
   - if resolved, persist `meta.delivery`, clear proposal, continue
3. If `meta.delivery` is not pending, continue.
4. Run the selector as today and write `delivery.md`.
5. If the selected delivery does not need confirmation, persist it as today.
6. If it does need confirmation:
   - store it in `meta.deliveryProposal`
   - leave `meta.delivery` pending
   - set `meta.resume = true`
   - save metadata
   - return `needsInput(...)`

Persist `userFacing` when triage determines it. On resume, prefer `task.meta.userFacing` before falling back to the existing diff heuristic.

Build the delivery confirmation question with `formatQuestions(...)` so inline Enter accepts the recommendation.

The first visible line should name the proposed action, for example:

```md
Confirm delivery - $ship auto-selected.

Factory inferred a side-effecting delivery action before implementation.
Proposed delivery: $ship (skill:ship)
Reason: Similar factory tasks have used ship.
Interactive: press Enter to accept, or type another answer.
Non-interactive: to accept, answer with `$ship`.

Accepted answers: `none`, `$pr`, `/pr`, `$ship`, `/ship`, or a one-off delivery policy.

- Run this delivery when the task finishes, after review, verify, and commit?
  Recommended: $ship
```

### `src/prompt.ts`

Detect the delivery-confirmation formatted question. For that question only, treat `/skip` like `/defer`: leave the task awaiting input and add it to the session deferred set.

### `README.md`

Document:

- auto-selected side-effecting delivery pauses before implementation
- explicit directives and manual delivery do not pause
- selected `none` does not pause
- Enter accepts in interactive runs
- non-interactive users accept with the recommended value, e.g. `factory add "$ship"`
- `delivery.md` remains raw selector output
- `questions.md` / `answers.md` record confirmation
- final `meta.delivery` is the confirmed or overridden delivery

## Tests

Add focused tests for:

- `deliveryNeedsConfirmation`
- `parseManualDelivery`
- `deliveryRecommendation`
- `applyDeliveryConfirmation`
- `latestAnswerValue`
- formatted question round trip through the existing parser
- conductor gate with existing `deliveryProposal`
  - no usable answer keeps `needs-input`
  - `$ship` confirms selected ship
  - `none` overrides to manual none
- persisted `userFacing` survives pre-implementation resume

## Verification

Run the repo gate after implementation:

```bash
bun run test
```

This should prove formatting, TypeScript, delivery parsing, answer parsing, and the conductor confirmation transition all remain coherent.
