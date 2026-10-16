# Local manual QA

This is a synthetic, manually executed test of the standalone node inside a local
n8n Community Edition host. Production scans are your actions after reviewing cost.
The local error workflows use fictional credentials and a loopback stub.

## Start

From the repository root in a POSIX terminal, use Node 24 (see `.nvmrc`) and npm
11.5.1 or later. Prepare the dependencies and host once, then start the editor:

```sh
npm run qa:prepare
npm run qa:local
```

Open the **QA editor** URL printed in that terminal (normally
`http://127.0.0.1:5678`). Preparation saves your Node 24 runtime for later starts,
even when your shell uses another Node version. Ctrl-C in that terminal stops the host,
development watcher and error stub. Restart with the same command.

Persistent private data is under `~/.local/share/guardfulai-n8n-qa/`; n8n's database,
encrypted credentials and encryption configuration are in `data/.n8n/`.
`session.json` records the actual URLs. Keep this directory private. The runner
does not reuse other n8n homes. To choose a specific unused port:
`npm run qa:local -- --port 5680`. Default port conflicts select another port.

If your shell uses another Node version, supply your Node 24 executable with
`npm run qa:prepare -- --node /absolute/path/to/node24`. Preparation installs locked
source dependencies, a dedicated npm 11.5.1 and one pinned n8n 2.42.4 host. Nothing
is installed globally. Keep the selected executable available for subsequent starts.

## One owner session

Use two browser tabs: the **local n8n editor** at the printed QA editor URL, and
**Guardful AI** at the service links below. Workflow nodes and n8n credentials are
configured in the local editor; policies, API keys, Activity and Usage are on the
Guardful AI website.

In n8n, open **Overview → Workflows** (or **Personal → Workflows** if your workflows
appear there), then click a workflow's name to open its **Editor** canvas. A node
is a box on that canvas. Double-click a node to open its detail panel; its
**Parameters** tab contains editable fields, and its **OUTPUT** pane shows results
from the latest execution. Close the node panel to return to the canvas.

1. **Find the prepared workflows in n8n.** Complete the first-run local owner
   account form if shown. This account is only for the local editor. In the
   **Workflows** list, search for **Guardful AI QA**. You should find
   **Guardful AI QA — production**, **Guardful AI QA — errors stop**, and
   **Guardful AI QA — errors continue**. Click **Guardful AI QA — production**.
   Keep all three unpublished/inactive; manual execution does not require publishing.

   If a workflow is missing, create a new empty workflow from the Workflows page,
   then open the **…** workflow menu in the editor's upper-right corner and choose
   **Import from File**. The generated files are under
   `~/.local/share/guardfulai-n8n-qa/workflows/`: use `production.json`,
   `errors-stop.json`, or `errors-continue.json` for the missing workflow, then save
   it. `import.json` contains all three if your import UI supports a bundle. Do not
   reimport over a workflow you have already configured.
2. **Check policies on the Guardful AI website.** In the other browser tab,
   [sign in](https://www.guardfulai.com/accounts/login/) to your intended workspace
   and open [Scan Policies](https://www.guardfulai.com/app/scan-policies/).
   Open the policies you intend to use and check for deterministic email-only rules
   with **Review**, **Block**, and **Redact-and-allow** actions. Confirm their
   published immutable versions and current short-input prices. If a required
   policy is absent or different, leave that case pending; do not substitute a
   model policy. The minimum policy recipe below describes the required behavior.
3. **Create the key on Guardful AI, then its credential in n8n.** On the website,
   open [Create integration key for n8n](https://www.guardfulai.com/app/keys/new/?integration=n8n).
   Review the recommended five operations and all-policy access needed for automatic
   batch reporting. Name it **Local n8n QA**, choose a seven-day expiry for this
   temporary test, and select **Create key**.

   Return to the **local n8n browser tab → Guardful AI QA — production → Editor**.
   Double-click the canvas node named **Guardful AI Check Content**. In its
   **Parameters** tab, open the credential dropdown near the top, labelled
   **Credential for Guardful AI API** (or **Credential**), and choose
   **Create new credential**. This opens a credential dialog of type
   **Guardful AI API**. Click the credential name at the top of that dialog and
   rename it **Guardful AI production QA**. Set **Service Origin** to
   `https://www.guardfulai.com` and paste the key into **API Key**. Click **Save**;
   n8n tests the connection when saving. Confirm the successful connection message,
   close the dialog, and check that **Guardful AI production QA** is selected in
   the node's credential dropdown. The test calls `/v1/auth/test` and does not scan
   or debit credits. See [n8n credential help](https://docs.n8n.io/credentials/add-edit-credentials/)
   if you cannot find the dropdown. Never put the key in workflow fields, exports,
   screenshots or chat. Do not select this credential in either error workflow.
4. **Configure the production workflow's nodes.** Close the node panel, then
   double-click the **QA settings** box on the same canvas, between the manual
   trigger and **Synthetic inputs**. This is an Edit Fields node renamed
   **QA settings**, not the workflow's Settings menu. In **Parameters → Fields to
   Set**, find the rows named `scenario`, `revision`, and `batch`. Edit the **value**
   beside `scenario` to the value in the matrix, starting with `review`. Leave
   `batch` unchanged and keep `revision=1` for the prepared requests. Changed
   requests require a new revision as explained below.

   Return to the canvas and double-click **Guardful AI Check Content** again.
   Under **Parameters**, keep **Operation → Check Content** and choose
   **Scan Policy → From List**, then select the intended policy/version from its
   dropdown. The choices show the version and price when supplied; null-priced policies remain selectable; replace the example's
   placeholder policy. Keep **Content** and **Source Event ID** as the existing
   expressions, **Direction → Input**, **Return Redacted Content** on,
   **Concurrency → 2**. Leave **Context** and **Supplied Fields (JSON)** blank for
   these examples. **Output** is also in this Parameters tab:
   start with **Simplified**. It includes the core result and batch-reporting fields, and omits original input,
   input availability and retention metadata. In **Options → Add Option**, choose
   **Input Retention** to set Organization Default, None, 1 Day, 7 Days or 30 Days;
   choose **Original Input in Output** to inherit, Show or Hide input in Raw or
   Selected Fields. For no Guardful AI input storage choose **None**; Hide alone
   does not disable storage. n8n retains its execution history separately. For the projection cases choose **Raw**, or
   **Selected Fields** and then select **Findings**, **Replayed**, and **Usage** in
   the **Fields** selector that appears. Close the panel and save workflow changes
   if the editor shows them as unsaved. Review the five-scan budget below before
   executing any production case.
5. **Run and inspect each matrix case in n8n.** Change the indicated node fields,
   return to the **Editor** canvas, and click **Execute workflow** at the bottom.
   Use the whole-workflow button for these cases. Do not pin node output, since
   pinned data would replace the real node execution on later manual runs.
   After the run, double-click **Guardful AI Check Content** and choose **JSON** in
   its **OUTPUT** pane to inspect each item's result. Close it and open
   **Inspect pairing** the same way; compare `qa_input_index` and
   `qa_source_event_id` with the corresponding **Synthetic inputs** item.
   Open **Continue only on Allow** to inspect its true/false output branches and
   check which terminal received items: **Allow — harmless end** or
   **Review, Block or error — harmless end**. A branch with no items should not
   execute its terminal. Compare the scan IDs, replay flags and charges with
   [Activity](https://www.guardfulai.com/app/activity/) and
   [Usage](https://www.guardfulai.com/app/usage/) in the Guardful AI tab.

   For the local error cases, return to n8n's **Workflows** list and open each
   **Guardful AI QA — errors stop** / **Guardful AI QA — errors continue** workflow.
   Double-click the **Guardful AI Check Content** node, select **Parameters**, and
   confirm the selected credential is **Guardful AI QA dummy (local only)**. Click
   the pencil/edit icon beside that credential to open its dialog. Keep **Service Origin** equal to the
   printed **Local error stub** URL and change **API Key** to the fictional control
   in the matrix (`qa-auth`, `qa-transport`, or `qa-conflict`), then **Save** and close.
   The two error workflows share this dummy credential, so an edit applies to both.
   Execute both workflows for each control. For a stopped run, inspect the check
   node's error; for a continued run, inspect its OUTPUT and the false branch.
   Restore `qa-auth` after testing.
6. **Clean up in both applications.** On Guardful AI's
   [Integration keys](https://www.guardfulai.com/app/keys/) page, open the temporary
   **Local n8n QA** key and revoke it. In the local n8n editor, open
   **Overview → Credentials** (or **Personal → Credentials**), find
   **Guardful AI production QA**, open it, and use its delete action, confirming
   the deletion. Keep the fictional local dummy credential if you want to repeat
   the error checks. In n8n's **Overview → Executions**, open/filter for the QA
   workflows, select unwanted synthetic executions and delete them. Keep the
   workflows unpublished. Return to the terminal running `npm run qa:local` and
   press Ctrl-C. Keep the private QA home for restart; remove only that dedicated
   home after stopping if you want to discard it entirely.

## Matrix and budget

| Case              | GUI action                                                                                   | Expected observation                                                                                                     | New scans |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- |
| Review/pairing    | **QA settings → scenario** = `review`; check node: Review policy, **Output → Simplified**; execute                                        | Two completed Review results; paired source IDs/indices 0 and 1; zero Allow items                                        | 2         |
| Exact replay      | Execute the same Review case unchanged                                                       | Same two scan IDs, `replayed=true`, no new debit                                                                         | 0         |
| Raw               | Keep Review request unchanged; check node: **Output → Raw**; execute                                           | Validated findings/check summaries; same scan IDs and strict routing fields                                              | 0         |
| Selected Fields   | Keep request unchanged; check node: **Output → Selected Fields**, **Fields → Findings, Replayed, Usage**; execute | Selected extras plus mandatory scan ID/status/decision/boolean safe flag                                                 | 0         |
| Benign Allow      | **QA settings → scenario** = `allow`; check node: same Review policy, **Output → Simplified**; execute                                    | One completed Allow, boolean safe flag true, harmless Allow terminal only                                                | 1         |
| Block             | **QA settings → scenario** = `block`; check node: Block policy; execute                                                      | One completed Block; zero Allow items                                                                                    | 1         |
| Redaction         | **QA settings → scenario** = `redact`; check node: Redact-and-allow policy; execute                                          | Completed Allow with `redacted=true`; inspect returned redacted content on the initial run; complete gate still required | 1         |
| Auth failure      | Open each error workflow; dummy credential key `qa-auth`; execute                            | Stop workflow fails; continued output is error/false with `invalid_api_key`; no Allow or copied content                  | 0         |
| Transport failure | In the same **local dummy** credential use `qa-transport`; run both error workflows          | Bounded retry then stop or continued error/false; no Allow                                                               | 0         |
| Conflict          | In the **local dummy** credential use `qa-conflict`; run both error workflows                | `409 idempotency_conflict`, no Allow; reset dummy key to `qa-auth` afterward                                             | 0         |

The dummy credential's origin must remain the **Local error stub** URL printed by
the runner. Its keys above are fictional test controls. Never select a production
credential in either error workflow.

Proposed budget: **2 × Review quote + benign Allow quote + Block quote + Redaction
quote**, five new scans. With the same email-only Review policy, the benign quote
normally equals its short-scan quote; confirm this for your inputs. Exact replays
and output-only changes should add zero. Prices are not confirmed until reviewed
in your selected account; no production consumption was performed by preparation.

All three strict conditions must pass: `status === "completed"`,
`decision === "allow"`, and `safe_to_continue === true` as a boolean. Synthetic
inputs deliberately contain Allow-shaped fields; continued errors must not retain
them. Error output omits decision, which the gate compares as an empty string.

Event IDs are derived from the saved batch, scenario, revision and item index.
Changing content or any request mapping requires increasing **revision** before
a new scan. Keep policy/version, content, context, fields, redaction setting,
reporting and item order identical for replay. Output selection is a local
projection and can change without changing the request. Never use a fresh ID just
to bypass `409 idempotency_conflict`; restore the original request for replay or
review an intentional new request and its cost first.

Minimum missing-policy recipe, for a separately authorized owner operation:
Input / local-only, email addresses (`data.email`) only, all other checks off,
with Review, Block, or Redact-and-allow action respectively. Review the policy
configuration and quote before publishing an immutable version. QA preparation
does not create or change production policies.

## Resume and diagnose

After node source changes, the watcher recompiles TypeScript; stop/restart with
`npm run qa:local` to ensure metadata/assets reload. Your editor configuration is
preserved. CLI import only adds missing QA workflow IDs. A source/example change
does not silently overwrite an already configured workflow.

Missing node: inspect the runner's error and `evidence/watcher.log`; restart after
fixing the build. Occupied explicit port: choose another `--port`. Already running:
use Ctrl-C in its original terminal. Unrecognized home: choose a fresh directory
with `--home /absolute/private/path` and prepare it; do not remove another host's
data. If the local dummy credential was deleted, recreate it with the printed
stub origin and `qa-auth`: open an error workflow, double-click the **Guardful AI
Check Content** node, select **Parameters**, and use the credential dropdown →
**Create new credential**.
Name it **Guardful AI QA dummy (local only)** and select it in both error workflows.

Report: host/node versions, scenario, output mode, status/decision, sanitized
error code, message and recovery description, pairing result, replay identity match and observed credit delta.
Exclude keys, headers, account/policy identifiers, request bodies and credential
exports. For a reproducible node defect, open an issue in the repository with these
sanitized observations, the expected behavior and reproduction steps using synthetic
inputs. Distinguish local mocked checks from production results.

Developer verification: `npm run qa:verify` performs local host/package checks;
it uses only fictional local credentials and never production scans. It requires
the QA host to be stopped and preserves existing workflow configuration.

## Starter acceptance without package preparation

After building the source with Node 24, run `npm run qa:starter`. This uses the
already-prepared pinned n8n runtime, a disposable SQLite home and a loopback-only
fictional service. It imports the starter, checks Review/Allow branches, batch
reporting, item pairing, transient retry and exact replay, and verifies that
retention inherits the organization default. It creates no package archive and
makes no production requests. `npm test` covers null-priced policy discovery,
dataset pagination/search, scope denial and sanitized malformed/transport errors.

For a real first-run check, follow the workspace n8n guide's starter download and
six steps. Create the key through its n8n-specific link to prefill the five
recommended scopes and all-policy access. Credential success confirms authentication
only. A real starter run consumes two checks; review the normal scan cost
before executing it. Review and Allow must reach separate harmless terminal nodes.
