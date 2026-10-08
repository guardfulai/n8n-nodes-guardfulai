# Validation

## Package and synthetic tests

From the repository root, use Node 24 and npm 11.5.1 or later:

```sh
npm ci
npm test
npm run lint
npm run build
npm run check:package
npm pack --dry-run --json
git diff --check
```

These checks have passed locally. Tests cover bounded stable retries, ordered item
pairing, typed custom facts, semantic assessment, dataset setup/reporting, output
projection and strict routing. Output settings are validated before consuming
requests. Continued errors cannot inherit Allow fields or content from input data.

Package checks inspect the actual tarball's file allowlist, metadata, imports and
content. Only compiled node/credential code, metadata, license and README are
distributed. The package has no ordinary runtime dependencies; tests, fixtures,
examples and QA tooling remain source-only. Review the complete repository for
public suitability separately from inspecting the npm payload.

## Local host verification

Follow [Local manual QA](QA.md) to prepare the pinned n8n Community Edition host.
With the QA host stopped, run:

```sh
npm run qa:verify
```

Local host verification has covered node and credential discovery, actual packed
package loading, inactive workflow import, configuration preservation across
restart, loopback listeners, private storage permissions and owned-process
shutdown. Focused runner tests cover runtime selection, port conflicts, directory
isolation, import preservation, deterministic identities and strict routing.

The packed node has executed HTTP 401, transport failure and HTTP 409 conflict
cases with both default stop and Continue On Fail. These checks use fictional
credentials and local mocked HTTP responses. Continued errors preserve item
pairing, expose sanitized error details and produce no Allow-branch items.
Generated logs, databases, runtime paths and artifact receipts stay outside the
source repository in the dedicated QA home.

## Acceptance limits

Local package and mocked host checks do not establish production API acceptance.
First-run editor account setup and authenticated picker/credential/workflow GUI
checks remain manual steps. Live authentication, Review/Allow/Block/redaction,
replay accounting and current policy versions/prices require the explicit manual
session in QA.md. Local verification makes no production scans.

Publication/provenance, the published package scanner, Creator Portal verification
and n8n Cloud availability require separate acceptance. Recheck current dependency
advisories before publication; no clean dependency-audit result is claimed. Review
development and host dependency trees separately from the runtime package, and do
not force dependency changes that invalidate the supported toolchain.
