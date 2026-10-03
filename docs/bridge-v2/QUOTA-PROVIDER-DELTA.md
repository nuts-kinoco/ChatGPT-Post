# Provider-bound quota follow-on

This portable delta stacks on PR3. It performs no real app-server/account read during development.

- `AccountQuotaPort.providerId` is the literal `codex` for the concrete public app-server adapter
- `TaskQuotaGuard.providerId` binds admission evidence to that provider; absent historical identity
  is unknown and is never inferred from a model, executor name or account-wide percentage
- Observed Codex quota can admit only an explicitly registered TaskSpec `agent:codex`
- Claude, Antigravity and normal Chat do not poll or consume Codex quota as their own. They stay
  unknown, or use a separately preauthorized bounded fallback subject to the same policy/grant
- Manual/unbound percentages cannot become provider evidence. Strict money-budget mode still
  denies because percentage observation is not a monetary guarantee
- `createBridgeDeployment().quotaSnapshot()` returns a cloned `bridge-quota-snapshot-1` with
  providerId, observation, bounded fallback and strictMoneyBudget. UI reads cause zero provider RPCs
  and cannot mutate the live admission guard
- New audit snapshots record requestedAgent/providerId separately from immutable Result bytes.
  Old rows lacking those fields stay unbound in UI/diagnostics, not retrospectively relabelled

The port identity is supplied by trusted concrete host code. It does not prove a model process uses
a particular account unless the later native/runtime composition also binds its authenticated
profile. It grants no credentials, reset credits, paid fallback or access to other provider accounts.

Portable regressions exercise positive Codex gating, Claude/AGY/Chat mismatch with zero quota RPCs,
missing metadata/manual percentage denial, explicitly bounded unknown fallback, cloned UI snapshots,
late-read fences, and post-ACK failure without changing result bytes or rerunning the model.
