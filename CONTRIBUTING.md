# Contributing to AgentPay Backend

Thanks for helping improve AgentPay Backend. This guide keeps contributions easy to review and aligned with the CI checks that run on every pull request.

## Development setup

1. Fork the repository and clone your fork.
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Run the full verification suite before opening a pull request:

   ```bash
   npm run lint
   npm run build
   npm test
   ```

4. For local development, start the API with:

   ```bash
   npm run dev
   ```

   The server listens on `http://localhost:3001`. Useful smoke checks are `GET /health` and `GET /api/v1/version`.

## Branch naming

Use short, issue-linked branch names so maintainers can connect your work to the campaign issue:

- `docs/docs-55-contributing-templates`
- `fix/issue-42-services-validation`
- `test/issue-37-webhook-coverage`
- `feat/issue-25-usage-summary`

Prefer prefixes such as `docs/`, `fix/`, `feat/`, `test/`, or `chore/`, followed by the issue number and a brief topic.

## Commit messages

Use concise, conventional-style commit messages:

- `docs: add contributor workflow templates`
- `test: cover service metadata endpoints`
- `fix: validate webhook event lists`

Keep commits focused. If a change affects behavior, include tests in the same pull request.

## Tests, linting, and coverage

- Run `npm run lint`, `npm run build`, and `npm test` before requesting review.
- Add or update tests for code changes.
- Aim for at least 95% coverage on impacted modules when coverage applies.
- Documentation-only changes do not need new tests, but the PR should explain that no runtime behavior changed.

## Security and secrets

- Do not commit API keys, private keys, seed phrases, `.env` files, wallet secrets, or production credentials.
- Use placeholders such as `AGENTPAY_API_KEY=example` in docs and templates.
- Mention any security-sensitive behavior in the pull request so reviewers can focus on it.

## Pull request checklist

Before opening a pull request:

- Link the related issue.
- Summarize the files changed and why.
- Confirm docs were updated when behavior or workflow changes.
- Confirm `npm run lint`, `npm run build`, and `npm test` pass, or explain why they were not run.
- Keep the PR small enough for a focused review.
