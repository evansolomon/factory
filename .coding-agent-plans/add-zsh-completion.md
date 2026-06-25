# Plan: Add Static Zsh Completion for `factory`

## Goal

Add `factory completion zsh`, which prints a sourceable/static zsh completion script so `factory ve<TAB>` completes or offers `version`. Keep completion side-effect free: no auto-upgrade, no git/repo loading, no prompts, no network, and no file mutation.

## Design

Introduce a small command metadata module used for two drift-prone surfaces:

1. Top-level command completion choices and descriptions.
2. Auto-upgrade command eligibility.

Keep CLI dispatch manual. Do not introduce a CLI framework or completion library. Treat per-command subcommands/options as static completion hints that mirror the existing parser behavior; do not refactor the parser into the metadata in this task.

Completion is zsh-only and static. Do not add bash/fish or dynamic task/repo/branch/file completion.

## Command Metadata

Add `src/commands.ts`.

Define typed metadata for:

- Active top-level commands.
- Deprecated accepted aliases hidden from completion.
- Per-command static options and fixed subcommands.
- Auto-upgrade eligibility.

Top-level active completion choices:

- `add`
- `run`
- `retry`
- `feedback`
- `correct`
- `backlog`
- `config`
- `status`
- `ask`
- `session`
- `codex`
- `claude`
- `show`
- `report`
- `lessons`
- `version`
- `upgrade`
- `completion`
- `help`

Deprecated accepted aliases:

- `answer`
- `resume`

Keep `answer` and `resume` auto-upgrade eligible if they are currently eligible, but hide them from the completion menu.

Export:

```ts
export const COMMANDS: readonly CommandSpec[]
export const AUTO_UPGRADE_COMMAND_NAMES: readonly string[]
export function activeCommandChoices(): readonly CompletionChoice[]
```

Descriptions shown in zsh completion should mirror the existing `HELP` command one-liners rather than inventing a third copy voice.

Model static grammar for:

- `completion zsh`
- `add`: `--raw`, `--trivial`, `--complexity trivial|complex`, `--verify`, `--edit`
- `run`: `--once`, `--drain`, `--no-prompt`
- `retry`, `feedback`, `correct`: `-m`, `--message`, `--message=`, `--edit`
- `backlog`: `add`, `rm`
- `backlog add`: `--raw`, `--verify`, `--edit`
- `ask`: `--print`
- `session`: `--agent codex|claude`, `--agent=codex|claude`
- `config`: `set`, `get`, `unset`, `inherit`, `edit`
- `config set`: `--task`, fixed key `on-complete`, then free text
- `config get|unset|inherit`: `--task`
- `config edit`: `--global`, `--worktree`, `--repo-parent`, `--dir`
- `show`: static step hints only if easy and already documented, such as `implement`, `review`, `verify`, `plan.codex`, `plan.claude`

Derive enum values from existing schemas where practical, especially task complexity. If importing an agent enum would create a cycle, use `['codex', 'claude'] as const` with a short comment naming the schema it mirrors.

## Completion Generator

Add `src/completion.ts`.

Export:

```ts
export function completionUsage(): string
export function renderZshCompletionScript(): string
export function runCompletion(args: string[]): number
```

Behavior:

- `factory completion zsh` prints the script to stdout and exits `0`.
- `factory completion` exits `1` with `usage: factory completion zsh`.
- Unsupported shells exit `1` with `unsupported shell "bash" (supported: zsh)` plus usage.
- Error/usage output for this command must go to stderr so `source <(factory completion bash)` does not feed error text into the shell.
- The script must never shell back out to `factory`.

The generated script should:

- Start with `#compdef factory`.
- Define `_factory`.
- Use `_arguments`, `_describe`, and command-specific `case` branches.
- Include top-level `--version`, `--help`, and `-h`.
- Support both enablement paths:
  - `source <(factory completion zsh)`
  - writing the script to an `_factory` file in `fpath`

Use the standard dual-mode zsh shape:

```zsh
#compdef factory

_factory() {
  # completion implementation
}

if [[ ${funcstack[1]} == _factory ]]; then
  _factory "$@"
else
  (( $+functions[compdef] )) && compdef _factory factory
fi
```

This keeps `fpath` autoload behavior working while making direct `source <(...)` register completion instead of invoking the function at shell startup.

## CLI Wiring

In `src/cli.ts`:

- Import `runCompletion`.
- Add the `completion` branch before `maybeAutoUpgrade` and before any context/git loading.
- Preserve existing `help`, `--help`, `version`, `--version`, and `upgrade` behavior.

Shape:

```ts
if (cmd === 'completion') {
  return runCompletion(rest)
}
```

Update `HELP` with:

```text
factory completion zsh       Print the zsh completion script (see README to enable).
```

Do not change installer behavior unless adding a non-mutating success hint.

## Auto-Upgrade

In `src/auto-upgrade.ts`:

- Replace the local hard-coded normal-command allow-list with `AUTO_UPGRADE_COMMAND_NAMES` from `src/commands.ts`.

Keep these ineligible:

- `help`
- `--help`
- `-h`
- `version`
- `--version`
- `upgrade`
- `completion`
- unknown commands

Keep existing eligible commands eligible, including deprecated accepted aliases if they are currently eligible.

## README

Update `README.md`:

- Add `factory completion zsh` to the Usage command block.
- Add a “Shell completion (zsh)” section near install/version/upgrade docs.
- State that the installer does not modify `.zshrc` or shell startup files.
- Document quick enable after `compinit` has run:

```bash
source <(factory completion zsh)
```

- Document persistent install using a user-owned completions directory:

```bash
mkdir -p ~/.zsh/completions
factory completion zsh > ~/.zsh/completions/_factory
```

`.zshrc`:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit
compinit
```

Do not suggest writing to `${fpath[1]}`.

Optionally add one success-only `install.sh` pointer:

```sh
echo "enable zsh tab completion (optional): factory completion zsh  # see README"
```

Do not make `install.sh` edit shell config.

## Tests

Add `tests/completion.test.ts`.

Cover:

- Script starts with `#compdef factory`.
- Script defines `_factory`.
- Script includes guarded `compdef _factory factory`.
- Script does not unconditionally call `_factory "$@"` when sourced.
- Top-level choices include `version`, `completion`, `add`, `run`, `config`, `backlog`, and the other active documented commands.
- Deprecated `answer` and `resume` are hidden from the top-level menu.
- Top-level options include `--version`, `--help`, and `-h`.
- `completion` offers `zsh`.
- `backlog` offers `add` and `rm`.
- `backlog add` offers `--raw`, `--verify`, `--edit`.
- `--complexity` offers `trivial` and `complex`.
- `--agent` and `--agent=` offer `codex` and `claude`.
- `retry`, `feedback`, and `correct` include `--message`, `--message=`, and `-m`.
- `config` offers its verbs.
- `config set` offers `on-complete` only as the config key, not repeatedly as arbitrary text.
- `runCompletion(['zsh'])` returns `0`.
- `runCompletion([])` and `runCompletion(['bash'])` return `1` with stdout clean and messages on stderr.

Add a spawn test from a temp non-git directory with temp `FACTORY_HOME`:

- `bun src/cli.ts completion zsh` exits `0`.
- stdout starts with `#compdef factory`.
- stderr is empty.
- `FACTORY_HOME` remains empty.

Add zsh smoke tests when `zsh` is available:

- `zsh -n` accepts the generated script.
- Source-mode registration works.
- `fpath`/`compinit` mode loads the `_factory` file.
- Where practical, drive completion for `factory ve` and assert `version` is offered.

Extend `tests/auto-upgrade.test.ts`:

- `completion` is auto-upgrade ineligible.
- `factory completion zsh` returns before auto-upgrade is called.
- `COMMANDS` auto-upgrade flags match `isAutoUpgradeCommand`.
- Existing eligible commands, including `answer` and `resume` if currently eligible, stay eligible.

Add focused metadata tests if useful:

- Active command choices include `version`.
- Hidden/deprecated commands are excluded from active completion choices.
- Auto-upgrade names match the intended current allow-list.

Do not add brittle README prose drift tests.

## Implementation Order

1. Add `src/commands.ts`.
2. Derive auto-upgrade eligibility from command metadata.
3. Add `src/completion.ts`.
4. Wire `completion` into `src/cli.ts` before auto-upgrade.
5. Update `HELP`.
6. Add completion and auto-upgrade tests.
7. Update README.
8. Optionally add the installer success hint.
9. Verify with the repo gate: `bun run test`.
