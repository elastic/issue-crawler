# Agent guidance

## Repository purpose

This repository has no README. From the source: it is a Node.js service that
crawls GitHub issues and indexes them into Elasticsearch, owned by the
`cloud-observability` team and run as the "GitHub Stats Crawler" Buildkite
pipeline.

**Gap:** A `README.md` explaining purpose, configuration (env vars), and
operation should be added. Until then, read `index.js`, `config.js`, and
`crawl.sh` for authoritative detail.

## AI attribution

For every AI tool that materially contributes to code, tests, documentation, configuration, or the substance of a change:

- Resolve the tool's runtime identity and add one unformatted trailer to the commit message. Use the exact model or agent slug and reasoning effort whenever exposed; omit unavailable components rather than guessing:

  ```text
  Assisted-by: <tool name> (<most specific verified runtime identity>)
  ```

- Repeat the same trailer in the pull-request description.
- Preserve the spelling and specificity of exposed runtime values; do not shorten a specific model slug to a broader model family.
- Preserve valid tool-native attribution, such as `Made with [Cursor](https://cursor.com)` or a genuine `Co-authored-by` trailer, in addition to `Assisted-by`.
- Never invent a bot identity, model name, or email address.
- Keep trailers on their own lines without bullets, Markdown emphasis, or surrounding underscores.
- Keep the human author or committer accountable for understanding and verifying the change.

For a squash merge, verify that the final squash commit message contains every attribution trailer. GitHub may populate that message from the pull-request description, commit information, or only the pull-request title depending on repository settings, so putting attribution in the PR description improves preservation but does not guarantee it.

When preparing a commit or pull request, offer to create it with the correct attribution. If the user will create it manually, show the exact trailers to copy into both places.

## Secret scanning

**Never place credentials, tokens, private keys, cookies, or production secret values in tracked files, examples, tests, prompts, logs, or generated output.** Use the approved Vault-backed secret store (Vault paths are in the Buildkite pipeline `*.env` configuration) and runtime injection mechanism instead.

Secret scanning controls are layered:

- **Pre-commit hook** — `elastic/gitleaks-hooks` at `v1.0.0` runs Gitleaks via `./bin/gitleaks` (Hermit-managed, v8.30.1). Install once with `pre-commit install`. The hook scans staged content before each commit.
- **GitHub secret scanning** — enabled (public repository).
- **Buildkite CI enforcement** — the existing pipeline uses `node:18` which lacks Python/pre-commit; CI enforcement is a gap requiring a new PR pipeline or image change.

If Gitleaks detects a secret, treat the finding as exposed, stop immediately, and rotate or revoke the credential before pushing. Never bypass the hook with `--no-verify`, `SKIP=gitleaks`, an allowlist entry, or a GitHub push-protection bypass reason unless the repository owner explicitly authorizes that exact override after reviewing the finding.
