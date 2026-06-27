# Plan: Add a Best-Effort Prototype Stage

## Design

Add a complex-path-only prototype stage after the selected `plan.md` is saved and before implementation starts. The stage is advisory, autonomous, and best-effort: the model decides whether a prototype materially reduces risk or clarifies the work, and the task loop continues regardless of skipped, malformed, or failed prototype output.

Prototype artifacts live only in the task directory. Model-selected primary artifacts are stored under `prototype-artifacts/` so they cannot overwrite task-owned files such as `plan.md`, `task.md`, `human-feedback.md`, or logs.

No new status, approval pause, feedback route, command, config flag, or closed artifact-type enum is added.

## Artifact Contract

Create `src/prototype.ts` to own prototype parsing, safe artifact writes, manifest handling, prompt context, and artifact discovery.

Use this parsed contract:

```md
PROTOTYPE: YES|NO
ARTIFACT: <relative basename or none>
REASON: <one sentence>
--- BEGIN ARTIFACT ---
<standalone artifact content>
--- END ARTIFACT ---
```

Rules:

- `PROTOTYPE: NO` records a skipped prototype with a reason.
- `PROTOTYPE: YES` requires a safe basename and non-empty artifact body.
- Safe names are basenames only: no absolute paths, no `/`, no `\`, no `..`, no empty names, no control characters.
- Created artifacts are written to `prototype-artifacts/<basename>`.
- `prototype.md` is always the human-readable summary or fallback record.
- `prototype.meta.json` records:
  - `decision: created | skipped | fallback`
  - normalized primary artifact path
  - originally requested filename
  - reason
- Malformed output writes raw output to `prototype.md`, writes a fallback manifest, logs a warning, and continues.

## Prompt Changes

In `src/prompts.ts`:

- Add the prototype marker contract to the marker comment.
- Add `prototypePrompt(...)`.
- The prompt should:
  - decide dynamically whether a prototype helps,
  - say complexity alone is not enough,
  - allow arbitrary standalone artifact types,
  - give non-exhaustive examples like HTML, Mermaid markdown, state-machine specs, architecture/data-flow diagrams, rollout sketches, and interface mocks,
  - require the exact marker contract,
  - state that implementation will not pause for approval.

Add prototype context blocks to `implementPrompt` and `fixPrompt` as trailing optional parameters. Place the block near plan/risk context, before feedback analysis, and frame it as advisory design context.

Do not thread prototype context into `feedbackAnalysisPrompt`.

## Conductor Wiring

In `src/conductor.ts`:

1. Add `runPrototypeStage(...)`.
2. Run it only on the fresh complex path, after `plan.md` is written and before delivery selection / implementation.
3. Use the implementer/lead agent with read access.
4. Save raw output as `prototype.raw.md` for debugging.
5. Parse and write through `src/prototype.ts`.
6. Log:
   - created artifact path / `file://` URL on success,
   - warning on malformed output or stage failure.
7. Continue on every prototype failure.
8. On resume, read existing prototype context from task artifacts.
9. Pass prototype context to implementation and fix prompts.

Keep task status as `planning` until implementation begins.

## Recovery

In `src/task.ts`, adjust stranded `planning` recovery:

- If `plan.md` exists, recover through the resumable path instead of discarding the selected plan.
- If `plan.md` does not exist, preserve current restart behavior.

This covers crashes during the new post-plan prototype window without adding a prototype-specific state.

## Visibility

In `src/view.ts`:

- Include `prototype.md` in `factory show`.
- If `prototype.meta.json` points to a primary artifact, show a pointer such as:

```txt
prototype artifact: file:///...
```

Do not inline arbitrary non-markdown artifacts such as HTML.

In `src/ask.ts`:

- Include `prototype.md` in saved-state context when present.
- Append compact prototype context with the primary artifact pointer.
- Do not dump full arbitrary HTML/SVG into ask context.

In `src/agent-session.ts`:

- Include `prototype.md` in handoff artifacts.
- Include the primary artifact from `prototype.meta.json` even if it is non-markdown.
- Do not include `prototype.meta.json` by default unless needed for debugging.

## Guidance

In `src/guidance.ts`, add `prototype` to the guidance-stage schema so learned guidance can target the stage without adding a new configuration surface.

## Documentation

Update `README.md` to describe:

- the complex-path prototype stage after final plan/risk and before implementation,
- that the stage is best-effort and autonomous,
- that there is no pre-implementation approval pause,
- how to inspect prototypes with `factory show`,
- how to open primary artifacts from the task directory,
- how prototype feedback uses existing `factory feedback` paths once feedback is eligible,
- task layout entries:
  - `prototype.md`
  - `prototype.raw.md`
  - `prototype.meta.json`
  - `prototype-artifacts/<artifact>`
- `prototype` as a learned-guidance stage.

## Tests

Add focused tests for:

- valid `PROTOTYPE: YES` parsing with arbitrary basename and content,
- valid `PROTOTYPE: NO`,
- fallback for missing/invalid prototype markers,
- fallback for malformed `YES`,
- fallback for unsafe names like `../x.html`, `nested/x.html`, and absolute paths,
- sentinel parsing with markdown horizontal rules inside artifact content,
- fallback never writing unsafe model-requested filenames,
- created prototype writes summary, manifest, and namespaced artifact,
- skipped prototype writes concise decision artifact,
- malformed output writes raw `prototype.md`,
- prototype context includes decision, reason, artifact path, and clipped content,
- `prototypePrompt` includes the marker contract, no-prototype option, and non-exhaustive examples,
- `implementPrompt` and `fixPrompt` include prototype context when provided,
- `factory show` prints prototype summary and primary artifact pointer without inlining HTML,
- `factory ask` includes compact prototype context,
- agent handoff includes `prototype.md` and dynamic primary artifacts,
- stranded `planning` recovery resumes when `plan.md` exists and preserves existing behavior when it does not,
- guidance schema accepts `prototype`.

## Verification

Run the repo gate after implementation:

```bash
bun run test
```

Key proof points:

- no prototype stage runs on trivial tasks,
- malformed prototype output never blocks the task,
- created artifacts cannot overwrite task-owned files,
- implementation and fix prompts receive prototype context,
- humans can discover prototypes through `factory show`,
- feedback workflow remains unchanged,
- no approval gate, new status, new config flag, or new command is introduced.
