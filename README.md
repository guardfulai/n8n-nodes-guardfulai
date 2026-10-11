# Guardful AI for n8n

Guardful AI checks content against a versioned Scan Policy and returns an Allow,
Review or Block decision. Use this node between an event trigger and its next action.
It also supports dataset setup and optional reporting context. The node can be used
in ordinary workflows and as an AI tool.

## Prerequisites and authentication

You need an n8n host, a reachable Guardful AI service, an account/workspace with a
published Scan Policy and sufficient credits, and a scoped API key. See
[Guardful AI](https://www.guardfulai.com/), the
[n8n integration guide](https://www.guardfulai.com/integrations/n8n/), and
[API documentation](https://www.guardfulai.com/api/).

Open your Guardful AI workspace's [Integration keys](https://www.guardfulai.com/app/keys/)
page and create a key restricted to your intended Scan Policies. For Check Content,
request `auth:test`, `scan_policies:read` and `scan:check`. Dataset operations need
`datasets:read` and/or `datasets:write`; reporting requires `datasets:write` and an unrestricted-policy key for dataset setup.
Use only the scopes needed by your workflow. Keep the secret in n8n credentials.
If your service uses another origin, use its Integration keys page instead.

Create a **Guardful AI API** credential:

| Field | Value |
| --- | --- |
| Service Origin | Default `https://www.guardfulai.com`; your fixed reachable HTTPS service origin, without a path/query/fragment |
| API Key | Your workspace's private scoped key; the field is masked |

Plain HTTP is permitted only for loopback development. The credential test calls
`GET /v1/auth/test`; it does not scan or spend credits. In a container, loopback
refers to the container: choose an origin reachable from the n8n process. Do not
put the secret in expressions, workflow exports, screenshots or chat.

## Check Content

1. Add **Guardful AI** and choose **Check Content**.
2. Select **Scan Policy** from the list. Each choice includes a version and price.
   The saved value pins that version; publishing a newer policy does not silently
   change this workflow. **By ID** accepts `policy-uuid::version`.
3. Map **Content**, **Source Event ID** and **Direction**. Supply **Context** and
   **Supplied Fields (JSON)** only when your policy needs them.
4. Choose whether to return redacted content. Review the policy cost before execution.
5. Add an IF/Switch step immediately afterward with the safe-routing rule below.

A Source Event ID is a durable identity from the upstream event, not a timestamp,
random value, content hash or n8n execution ID generated for each retry. Distinct
events need distinct identities. Retry with the same event ID, item order, policy
ID/version, content, context, supplied fields and reporting context. The node combines
event ID, item index and policy ID/version into its idempotency key. Reordering items
changes their identities. The API external ID is limited to the first 64 characters;
use short opaque IDs. Changing a request under the same identity is a conflict.

**Concurrency** bounds simultaneous checks and preserves input ordering and item
pairing. It does not change the charge for a new scan. **Supplied Fields (JSON)**
is a JSON object of up to 16 scalar fields, for example
`{"amount":750,"approved":false}`. Preserve the policy's field types. Nested values,
malformed JSON and incomplete semantic results fail closed.

### Safe routing

Continue only when **all three** conditions are true, using strict types:

```text
status == completed
decision == allow
safe_to_continue == true
```

Review and Block go to separate handling, never to the next consuming action.
Unknown/malformed results, authentication, credit, transport and API failures also
must not proceed. Default errors stop the workflow. With **Continue On Fail**, the
node returns `status: error`, `safe_to_continue: false` and a sanitized
`guardfulai_error`; it never carries Allow fields from the input into an error result.
Do not rely only on `decision`, HTTP status, a truthy string, or absence of findings.

### Output and redaction

**Simplified** (default) returns ten fields: scan ID, status, decision, safe-to-continue,
policy version, flagged/redacted flags, optional redacted content, replay flag and usage.
**Raw** returns the full validated result projection, including findings, check summaries,
runtime identity and semantic assessments when present. It does not return an unfiltered
HTTP body. **Selected Fields** lets you choose additional fields; scan ID, status,
decision and safe-to-continue remain present. Safety validation runs before projection.

Redacted content is returned only when requested and supplied by the API. Redaction
alone does not grant permission to continue; apply the complete routing rule. A custom
policy's compliant/violated/uncertain assessments are validated as a complete set;
uncertainty cannot become Allow.

### Errors and retries

Requests have a 30-second timeout. Check Content makes at most three total attempts
for network failures or API-marked retryable 409/429/503/504 responses. It reuses the
same request and idempotency key. Retry-After delays are bounded. Authentication,
insufficient credits, non-retryable conflicts and malformed results are not retried.
A timeout may follow a settled scan: replaying the same identity recovers its result
instead of requesting another scan. Resolve credentials/scopes, credits or conflicting
mappings before trying again; do not generate a fresh identity just to bypass a conflict.

## Datasets and reporting

- **List Datasets** returns one page (up to 50 datasets); choose a page explicitly.
- **Create Dataset** creates an events or latest-run dataset. It never scans content.
- **Create Dataset Run** creates or recovers a run using a stable opaque run identity.
  Reuse the identity for recovery; use a new one for an intentional new snapshot.

Setup operations execute once using the first item's parameters. Use Check Content
for per-item scans. **Dataset Reporting Context** accepts JSON with `dataset_id`,
`record_id`, optional `run_id`, one event date/time and chosen dimensions. For example:

```json
{"dataset_id":"00000000-0000-4000-8000-000000000001","record_id":"ticket-42","event_date":"2026-10-08","dimensions":{"team":"support"}}
```

Use `run_id` for run-based datasets. Keep context identical on retry. Never put content,
credentials or personal data into reporting dimensions. Dataset setup requests do not
consume scan credits; attaching reporting to a scan does not bypass scan authorization.

## Example workflow

Import [examples/check-content.json](examples/check-content.json) into your local editor.
It is inactive, contains fictional `.test` inputs, and has no credentials or live
service actions. Select your credential and actual policy/version. Its
**Continue only on Allow** IF node uses all three strict conditions. Both branches end
in harmless placeholders. Replace them only after validating your routing. Credential
references are absent; policy IDs are placeholders, not usable account data.

## Privacy

n8n receives mapped content and can retain input, context, supplied fields, output,
findings and redacted text in execution history even if Guardful AI does not retain
realtime content. Set retention/pruning and access controls for your n8n deployment.
Use synthetic content for QA. Do not include secrets or content in node names,
reporting dimensions, diagnostics, workflow exports or notifications.

## Local development

For a pinned local host and synthetic manual testing, follow the preparation steps in
[Local manual QA](QA.md), then start it with `npm run qa:local`; the command prints the
editor URL and keeps its private persistent data outside this repository.

Use Node 24 (see `.nvmrc`) and npm 11.5.1 or later.

```sh
npm ci
npm test
npm run lint
npm run build
npm pack --dry-run --json
npm pack
npm run dev -- --custom-user-folder $HOME/guardfulai-n8n-dev
```

The official development CLI starts a local n8n instance with the node loaded and
watches changes. Open the URL it prints. Use a dedicated development home and an
unused port rather than another n8n user's installation. Depending on the selected
n8n version, Docker/Podman may be needed; the CLI also supports `--external-n8n` for
an independently started host with `N8N_DEV_RELOAD=true`. See the
[official development instructions](https://docs.n8n.io/connect/create-nodes/build-your-node/using-the-n8n-node-tool/).
Development-host environment settings do not authorize runtime node access to them.

Unit tests use mocked requests and synthetic fixtures. Build and inspect the actual
packaged payload before release: only compiled node/credential code, metadata,
license and README are distributed. Tests and examples remain source-repository files.

## Publication and support

CI checks the node on pushes and pull requests. The prepared `publish.yml` runs only
on version tags such as `0.1.0`, checks the package, and publishes through GitHub Actions
with provenance. Tags/releases, npm publication and Creator Portal submission require
explicit owner authorization. Do not run `npm run release` as a validation command.
For the first unpublished name, bootstrap authentication precedes Trusted Publisher
configuration; future publishing uses OIDC. No publication settings are configured here.

Use [Guardful AI help](https://www.guardfulai.com/help/) for service questions and the
intended public repository's issues after it is created for node-specific problems.
Report sanitized error codes and versions; never share keys or request content.

## Input retention

New checks inherit the organization input retention (seven days by default) and original-input visibility. The node can choose no retention, one, seven, or thirty days and explicitly show or hide input. Available input and retention status are included in simplified and raw outputs; selected output exposes these as optional fields. Retention failures do not change the check decision. n8n execution history has its own retention settings.
