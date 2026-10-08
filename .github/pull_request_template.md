## What changed?

Describe the user-visible change and why it is needed.

## Evidence

List the exact commands, tests, or manual probes that you ran and their
results. Include failure-path evidence for security or delivery changes.

## Platforms

- [ ] Linux
- [ ] macOS
- [ ] Docker
- [ ] Not platform-specific

Explain any platform that was not exercised.

## Risk and rollback

Describe effects on authentication, policy, stored data, protocol behavior,
or public interfaces. State how to disable or roll back the change.

## Checklist

- [ ] I added or updated tests for changed behavior.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] I updated user documentation and release notes when needed.
- [ ] I did not include secrets or private machine data.
