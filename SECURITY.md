# Security policy

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go
to <https://github.com/Tech0001/orrery/security/advisories/new>. Please don't open a public issue.

Include the affected commit or version, steps to reproduce and the impact. Use synthetic keys and data; never send real
credentials or memory.

Orrery has one maintainer. Reports are acknowledged as soon as possible. Fixes ship in a new release, with credit to
the reporter unless they prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## In scope

- Keys or tokens leaking into logs, notices, model context, memory, exports or backups
- Bypassing the credential guard for a path or tool argument it claims to cover
- An agent reading another agent's memory beyond the documented `agents` and `agent_memory` tools
- Remote agents: reading or changing memory without the recovery code, or writing past the one-writer lock
- Import scrubbing missing a secret format it claims to catch
- Hijacking a sign-in flow (OAuth or OpenRouter PKCE)

## Out of scope

- What shell commands can do: the credential guard is not a sandbox (see [Safety](README.md#safety))
- Attacks that need an already compromised local account or root
- Local working copies being unencrypted, which is documented
- What model providers do with the context sent to them
- Vulnerabilities in pi, OMP, Claude Code, Ori or Codex themselves, which belong upstream. How Orrery uses them is in
  scope.
