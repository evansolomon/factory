export type CompletionWriter = {
  write(chunk: string): unknown
}

export type CompletionIo = {
  stdout: CompletionWriter
  stderr: CompletionWriter
}

const defaultIo: CompletionIo = {
  stdout: process.stdout,
  stderr: process.stderr,
}

export function completionUsage(): string {
  return 'usage: factory completion zsh'
}

// A thin shim: ALL candidates (commands, flags, static and dynamic values) are
// computed by the hidden `factory __complete` helper at TAB time by walking the
// command registry (complete.ts) — the script itself knows nothing about the
// command surface, so it can never drift from the dispatcher. It invokes the
// completed word itself (${words[1]}), so whichever factory binary you're
// completing is the one that answers. Helper output is `name\tdescription`
// lines; only `:` needs escaping for _describe after the TS-side sanitization.
export function renderZshCompletionScript(): string {
  return `#compdef factory

_factory() {
  local -a lines candidates
  local line name desc
  lines=("\${(@f)$("\${words[1]}" __complete $(( CURRENT - 2 )) "\${(@)words[2,-1]}" 2>/dev/null)}")
  candidates=()
  for line in "\${(@)lines}"; do
    [[ $line == *$'\\t'* ]] || continue
    name=\${line%%$'\\t'*}
    desc=\${line#*$'\\t'}
    name=\${name//:/\\\\:}
    if [[ -n $desc ]]; then
      candidates+=("$name:$desc")
    else
      candidates+=("$name")
    fi
  done
  (( \${#candidates[@]} > 0 )) || return 1
  _describe -t factory-candidates 'factory completion' candidates
}

if [[ \${funcstack[1]} == _factory ]]; then
  _factory "$@"
else
  (( $+functions[compdef] )) && compdef _factory factory
fi
`
}

export function runCompletion(args: string[], io: CompletionIo = defaultIo): number {
  const [shell, ...extra] = args
  if (!shell) {
    io.stderr.write(`${completionUsage()}\n`)
    return 1
  }
  if (shell !== 'zsh') {
    io.stderr.write(`unsupported shell "${shell}" (supported: zsh)\n${completionUsage()}\n`)
    return 1
  }
  if (extra.length > 0) {
    io.stderr.write(`${completionUsage()}\n`)
    return 1
  }
  io.stdout.write(renderZshCompletionScript())
  return 0
}
