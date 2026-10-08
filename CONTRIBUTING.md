# Contributing

Thanks for helping. The bar for changes is behavioural evidence.

1. `npm ci && npm test` must pass on Linux and macOS (CI runs both).
2. New behaviour needs a test that exercises the real thing — real files,
   real child processes, real HTTP/WebSocket on an ephemeral port. Mocks are
   acceptable only for things we cannot run in CI (e.g. a third-party API).
3. Anything touching delivery semantics (request states, recovery,
   idempotency) or security (auth, policy, path resolution) needs an
   adversarial/error-path test, not only the happy path.
4. Record consequential design changes as an ADR in `docs/adr/`.
5. Never commit secrets; CI runs gitleaks.

Commit messages: imperative mood, explain *why* in the body.
