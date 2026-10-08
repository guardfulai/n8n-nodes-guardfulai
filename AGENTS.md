# Guardful AI n8n node

This repository is the public source of truth for the Guardful AI n8n community node,
including before publication. Keep its Git history, commits, dependencies and checks
independent from other repositories.

- Never copy private backend source, internal documentation, evidence, local state or
  secrets here. Use public Guardful AI API contracts and synthetic test fixtures only.
- Every committed file must be suitable for public sharing, including instructions,
  documentation, scripts, tests, fixtures, configuration and metadata. Exclude personal
  checkout paths, machine setup reports, internal repository names, proprietary
  implementation details, real account/policy identifiers, credentials and private
  evidence. Write portable setup steps and undated validation summaries; dependency
  versions and clearly synthetic examples may remain.
- Keep local configuration and evidence outside the repository by default. Ignore only
  narrowly scoped files that genuinely need to live in the checkout. Git ignores do not
  sanitize tracked files or history. Review the full source tree as well as the npm
  payload before sharing; flag historical disclosures without rewriting history.
- Follow current n8n community verification and UX guidance. Keep strict lint enabled,
  TypeScript, MIT licensing and English documentation/UI.
- Runtime node code must not access environment variables or the filesystem. No ordinary
  runtime dependencies unless n8n explicitly permits them; use n8n HTTP helpers.
- Preserve fail-closed routing, immutable policy selection and stable retry identity.
  Every output mode retains scan identity and routing fields. Error output never carries
  an Allow signal from input data.
- Run `npm test`, `npm run lint`, `npm run build` and inspect `npm pack` before completion.
  Use Node 24, `npm ci` and the committed lockfile. Local dev data stays ignored.
- GitHub/npm publication, release tags and Creator Portal submission require explicit
  authorization. A prepared publishing workflow is not publication authority.
