---
name: kubectl-access
description: This skill should be used whenever Claude needs to run `kubectl` against a cluster from this repo — checking pods, logs, events, applying or describing resources, troubleshooting, or any operation that needs a kubeconfig + context. It deterministically resolves which kubeconfig and context to use, persists the choice locally (gitignored), and never mutates the user's shell state.
version: 1.0.0
---

# kubectl-access

This skill tells Claude how to obtain and use cluster credentials when working in the `medicard/infra` repo. It must be applied **before any `kubectl` invocation**.

## Conventions

- **Canonical local kubeconfig:** `.kube/config` at the repo root. Mirrors `~/.kube/config` so there is zero cognitive overhead.
- **Choice memory file:** `.kube/.claude-choice.json` — JSON of the form `{"kubeconfig": ".kube/config", "context": "<context-name>"}`.
- **Both live under `.kube/`, which is gitignored.** Never commit anything from this directory.
- **Never mutate shell state.** Do **not** `export KUBECONFIG=...` and do **not** run `kubectl config use-context ...`. Always pass `--kubeconfig` and `--context` as flags on every invocation. This keeps the user's shell hermetic.

## Resolution algorithm

Run this every time before the first `kubectl` call in a turn. Stop at the first step that produces a usable answer.

### Step 1 — Honor the remembered choice

If `.kube/.claude-choice.json` exists:

1. Parse it.
2. Verify the file at `.kubeconfig` path still exists.
3. Verify the context still exists:
   ```bash
   kubectl --kubeconfig <path> config get-contexts -o name
   ```
4. If both checks pass, **use this choice silently — ask nothing**.
5. If either check fails, delete the stale `.kube/.claude-choice.json` and fall through to Step 2.

### Step 2 — Discover candidate kubeconfigs

Look in this order. The first non-empty result wins.

1. `.kube/config`
2. `.kubeconfig` (legacy — see "Migration" below)
3. `kubeconfig.yaml` or any `*.kubeconfig` in the repo root
4. **Fallback only if nothing local exists:** `~/.kube/config` and per-cluster files in `~/.kube/` (this repo's docs install kubeconfigs as `~/.kube/<cluster-name>`)

### Step 3 — Pick a kubeconfig

- **0 candidates:** Tell the user no kubeconfig is available and stop. Suggest one of:
  ```bash
  mise run provision -- --merge-kubeconfig
  # or
  terraform output -raw kubeconfig > .kube/config
  ```
  Do not proceed.

- **1 candidate:** Use it. Do not ask.

- **2+ candidates:** Use `AskUserQuestion` with one option per discovered file. After the user picks, write the choice to `.kube/.claude-choice.json` (creating `.kube/` if needed).

### Step 4 — Pick a context

After a kubeconfig is selected, list its contexts:

```bash
kubectl --kubeconfig <path> config get-contexts -o name
```

- **1 context:** Use it. Do not ask.
- **2+ contexts:** Use `AskUserQuestion`, then update `.kube/.claude-choice.json` with the chosen context.

### Step 5 — Invoke kubectl

Every kubectl call in the session uses explicit flags:

```bash
kubectl --kubeconfig <path> --context <ctx> <subcommand> ...
```

This is non-negotiable. Never `export KUBECONFIG`, never `kubectl config use-context`.

## Re-prompt rules

If the user says any of:

- "switch context" / "use a different context"
- "use prod" / "use staging" / "use the other cluster"
- "use a different kubeconfig"

…then delete `.kube/.claude-choice.json` (or the relevant field) and re-run the resolver from Step 2.

## Migration of the legacy `.kubeconfig`

On the first run in a repo that has `.kubeconfig` at the root but no `.kube/config`:

1. Tell the user: "I found a legacy `.kubeconfig` at the repo root. Best practice is `.kube/config` so the whole `.kube/` directory can be gitignored."
2. Use `AskUserQuestion` to offer:
   - **Move it** — `mkdir -p .kube && mv .kubeconfig .kube/config`
   - **Leave it** — keep using `.kubeconfig` for now
3. Whichever the user picks, persist the resulting path in `.kube/.claude-choice.json`.

Do not move files without confirmation.

## Writing the choice file

```bash
mkdir -p .kube
cat > .kube/.claude-choice.json <<'JSON'
{
  "kubeconfig": ".kube/config",
  "context": "medicard-staging"
}
JSON
```

Use the actual selected values, of course. Always write valid JSON; do not append.

## Quick reference: common safe invocations

```bash
# Pods in a namespace
kubectl --kubeconfig .kube/config --context <ctx> -n <ns> get pods

# Logs
kubectl --kubeconfig .kube/config --context <ctx> -n <ns> logs <pod> --tail=200

# Events (sorted)
kubectl --kubeconfig .kube/config --context <ctx> -n <ns> get events --sort-by=.lastTimestamp

# Describe a resource
kubectl --kubeconfig .kube/config --context <ctx> -n <ns> describe <kind>/<name>
```

## Hand-off to other skills

The `argocd-ops` skill depends on this one. Any skill that runs `kubectl` must first follow the resolution algorithm above.
