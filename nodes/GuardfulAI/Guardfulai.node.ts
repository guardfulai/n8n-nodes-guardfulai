import { createHash } from "node:crypto";
import { datasetId, reportingContext } from "./reporting";
import type {
  ICredentialTestFunctions,
  ICredentialsDecrypted,
  ICredentialDataDecryptedObject,
  INodeCredentialTestResult,
  INode,
  IDataObject,
  IExecuteFunctions,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INodeListSearchResult,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeConnectionTypes, NodeOperationError } from "n8n-workflow";

import { datasetSetup } from "./dataset-setup";
import { contractError, presentError, requestError } from "./errors";
import { selectOutput, validateOutputOptions, OUTPUT_FIELDS } from "./output";

import {
  checkContent,
  normalizeOrigin,
  parsePolicySelection,
  REQUEST_TIMEOUT_MS,
  type HttpResponse,
  type PolicyOption,
  type Requester,
  runBounded,
} from "./transport";

function operationError(
  node: INode,
  error: unknown,
  itemIndex?: number,
  fallback = "integration_error",
) {
  const detail = presentError(error, fallback);
  return new NodeOperationError(node, `${detail.message} (${detail.code})`, {
    description: detail.description,
    itemIndex,
  });
}

export class Guardfulai implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Guardful AI",
    name: "guardfulai",
    group: ["transform"],
    version: 1,
    description: "Check content with a pinned Guardful AI Scan Policy",
    icon: { light: "file:guardfulai.svg", dark: "file:guardfulai.dark.svg" },
    subtitle: '={{$parameter["operation"]}}',
    defaults: { name: "Guardful AI" },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [
      {
        name: "guardfulaiApi",
        required: true,
        testedBy: "testGuardfulAICredential",
      },
    ],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Check Content", value: "checkContent", action: "Check content" },
          { name: "Create Dataset", value: "createDataset", action: "Create a dataset" },
          { name: "Create Dataset Run", value: "createDatasetRun", action: "Create or recover a dataset run" },
          { name: "List Datasets", value: "listDatasets", action: "List datasets" },
          { name: "Set Up Batch Dataset", value: "setupDatasetRun", action: "Set up a batch dataset" },
        ],
        default: "checkContent",
      },
      {
        displayName: "Dataset", name: "datasetDestination", type: "options", default: "new",
        displayOptions: { show: { operation: ["checkContent", "setupDatasetRun"] } },
        options: [{ name: "New Dataset", value: "new" }, { name: "Existing Dataset", value: "existing" }, { name: "Standalone Scans", value: "standalone" }],
        description: 'Destination for multi-record executions. Explicit reporting contexts retain their selected destination.',
      },
      {
        displayName: "New Dataset Name", name: "batchDatasetName", type: "string", default: "",
        displayOptions: { show: { operation: ["checkContent", "setupDatasetRun"], datasetDestination: ["new"] } },
        description: 'Leave blank for a dated name. Reuse the same name on retry.',
      },
      {
        displayName: "Existing Dataset", name: "batchDataset", type: "resourceLocator", default: { mode: "list", value: "" },
        displayOptions: { show: { operation: ["checkContent", "setupDatasetRun"], datasetDestination: ["existing"] } },
        modes: [
          { displayName: "From List", name: "list", type: "list", typeOptions: { searchListMethod: "getDatasets", searchable: true } },
          { displayName: "By ID", name: "id", type: "string" },
        ],
      },
      {
        displayName: "Scan Policy",
        name: "scanPolicy",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "resourceLocator",
        default: { mode: "list", value: "" },
        required: true,
        modes: [
          {
            displayName: "From List",
            name: "list",
            type: "list",
            typeOptions: {
              searchListMethod: "getScanPolicies",
              searchable: true,
            },
          },
          {
            displayName: "By ID",
            name: "id",
            type: "string",
            placeholder: "e.g. policy-uuid::1",
          },
        ],
        description:
          "Choose a published policy version from the list, or enter its ID and version",
      },
      {
        displayName: "Content",
        name: "content",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        description:
          "Content to check; sent to the configured Guardful AI origin",
      },
      {
        displayName: "Source Event ID",
        name: "eventId",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "string",
        default: "",
        required: true,
        description:
          "Stable ID for this source event. Reuse it on retries; distinct events need distinct IDs.",
      },
      {
        displayName: "Direction",
        name: "direction",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "options",
        options: [
          { name: "Input", value: "input" },
          { name: "Output", value: "output" },
        ],
        default: "input",
      },
      {
        displayName: "Context",
        name: "context",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "string",
        typeOptions: { rows: 3 },
        default: "",
        description:
          "Optional context counted as analyzed input; not returned in findings",
      },
      {
        displayName: "Supplied Fields (JSON)",
        name: "structuredFields",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "string",
        typeOptions: { rows: 3 },
        default: "",
        description:
          'Map a JSON object of typed facts required by the policy, for example {"amount":750,"approved":false}',
      },
      {
        displayName: "Return Redacted Content",
        name: "returnRedactedContent",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "boolean",
        default: false,
        description:
          "Whether to return an ephemeral redacted value in this workflow execution",
      },
      {
        displayName: "Dataset Reporting Context",
        name: "reporting",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "json",
        default: "",
        description:
          "Optional JSON with dataset_id, record_id, optional run_id, one event date, and chosen dimensions. Keep identical on retry; never copy content into metadata.",
      },
      {
        displayName: "Output",
        name: "output",
        type: "options",
        displayOptions: { show: { operation: ["checkContent"] } },
        options: [
          {
            name: "Simplified",
            value: "simplified",
            description:
              "Return up to ten decision, identity, redaction and usage fields; no original input",
          },
          {
            name: "Raw",
            value: "raw",
            description:
              "Return all validated result fields, including findings",
          },
          {
            name: "Selected Fields",
            value: "selected",
            description:
              "Choose fields; scan identity and routing fields are always included",
          },
        ],
        default: "simplified",
        description:
          "Result fields to return. Raw includes only the validated result projection.",
      },
      {
        displayName: "Fields",
        name: "outputFields",
        type: "multiOptions",
        displayOptions: {
          show: { operation: ["checkContent"], output: ["selected"] },
        },
        options: OUTPUT_FIELDS,
        default: [],
        description: "Additional result fields to return",
      },
      {
        displayName: "Concurrency",
        name: "concurrency",
        displayOptions: { show: { operation: ["checkContent"] } },
        type: "number",
        typeOptions: { minValue: 1, maxValue: 8 },
        default: 4,
        description: "Maximum in-flight item checks for this node execution",
      },
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: { show: { operation: ["checkContent"] } },
        options: [
          {
            displayName: "Input Retention",
            name: "inputRetentionDays",
            type: "options",
            default: -1,
            description:
              "How long Guardful AI stores original input. Organization Default initially means seven days. None disables storage; n8n history is separate.",
            options: [
              { name: "1 Day", value: 1 },
              { name: "30 Days", value: 30 },
              { name: "7 Days", value: 7 },
              { name: "None", value: 0 },
              { name: "Organization Default", value: -1 },
            ],
          },
          {
            displayName: "Original Input in Output",
            name: "includeInput",
            type: "options",
            default: "default",
            description:
              "Show or hide input in Raw or Selected Fields. This does not change retention. Simplified never includes original input.",
            options: [
              { name: "Organization Default", value: "default" },
              { name: "Show", value: "true" },
              { name: "Hide", value: "false" },
            ],
          },
        ],
      },
      {
        displayName: "Dataset Name",
        name: "datasetName",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["createDataset"] } },
        description:
          "Create metadata once. After an uncertain response, list datasets before creating again.",
      },
      {
        displayName: "Reporting Basis",
        name: "reportingBasis",
        type: "options",
        options: [
          { name: "Events", value: "events" },
          { name: "Latest Run", value: "latest_run" },
        ],
        default: "events",
        displayOptions: { show: { operation: ["createDataset"] } },
      },
      {
        displayName: "Dataset ID",
        name: "datasetId",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["createDatasetRun"] } },
        description:
          "Select an exact ID returned by List Datasets. Setup needs explicit datasets:write and all-policy access.",
      },
      {
        displayName: "Run Identity",
        name: "runIdentity",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { operation: ["createDatasetRun", "setupDatasetRun"] } },
        description:
          "Stable opaque batch ID. Reuse on retry; use a new ID for an intentional new snapshot.",
      },
      { displayName: "Expected Records", name: "expectedRecords", type: "number", default: 0, typeOptions: { minValue: 0, maxValue: 50000 }, displayOptions: { show: { operation: ["setupDatasetRun"] } }, description: "Number of non-empty records in this batch" },
      {
        displayName: "Page",
        name: "datasetPage",
        type: "number",
        default: 1,
        typeOptions: { minValue: 1, maxValue: 100000 },
        displayOptions: { show: { operation: ["listDatasets"] } },
        description: "Return up to 50 datasets per page",
      },
    ],
  };

  methods = {
    credentialTest: {
      async testGuardfulAICredential(
        this: ICredentialTestFunctions,
        credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
      ): Promise<INodeCredentialTestResult> {
        try {
          const data = credential.data ?? {};
          const origin = normalizeOrigin(data.serviceOrigin);
          if (typeof data.apiKey !== "string" || !data.apiKey.trim())
            throw contractError("credentials_required");
          // n8n's ICredentialTestFunctions exposes only request, including on the
          // pinned host. Keep this exception confined to credential testing.
          // eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
          const response = (await this.helpers.request({
            method: "GET",
            uri: `${origin}/v1/auth/test`,
            headers: { Authorization: `Bearer ${data.apiKey}` },
            json: true,
            resolveWithFullResponse: true,
            simple: false,
            timeout: REQUEST_TIMEOUT_MS,
          })) as HttpResponse;
          if (response.statusCode !== 200) throw requestError(response);
          if (
            !response.body ||
            typeof response.body !== "object" ||
            (response.body as Record<string, unknown>).authenticated !== true
          )
            throw contractError("invalid_api_response");
          return {
            status: "OK",
            message:
              "Guardful AI authenticated the credential. Operation permissions are checked when used. No scan credits were consumed.",
          };
        } catch (error) {
          const detail = presentError(error, "integration_transport_error");
          return {
            status: "Error",
            message: `${detail.message} (${detail.code}). ${detail.description}`,
          };
        }
      },
    },
    listSearch: {
      async getDatasets(this: ILoadOptionsFunctions, filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
        try {
          let credentials;
          try {
            credentials = await this.getCredentials("guardfulaiApi");
          } catch {
            throw contractError("credentials_required");
          }
          const origin = normalizeOrigin(credentials.serviceOrigin);
          const page = Number(paginationToken || "1");
          if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw contractError("dataset_page_invalid");
          const response = await this.helpers.httpRequestWithAuthentication.call(this, "guardfulaiApi", {
            method: "GET", url: `${origin}/v1/datasets?page=${page}&page_size=50&search=${encodeURIComponent((filter || "").slice(0, 120))}`,
            json: true, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: REQUEST_TIMEOUT_MS,
          }) as HttpResponse;
          if (response.statusCode !== 200) throw requestError(response);
          const body = response.body as { datasets: { id: string; name: string }[]; total: number };
          if (!body || !Array.isArray(body.datasets) || body.datasets.length > 50 || !Number.isSafeInteger(body.total) || body.total < 0) throw contractError("dataset_response_invalid");
          return { results: body.datasets.map(row => {
            if (!row || typeof row.name !== "string") throw contractError("dataset_response_invalid");
            let id;
            try { id = datasetId(row.id); } catch { throw contractError("dataset_response_invalid"); }
            return { name: row.name, value: id };
          }), paginationToken: page < 100000 && page * 50 < body.total ? String(page + 1) : undefined };
        } catch (error) {
          throw operationError(this.getNode(), error, undefined, "integration_transport_error");
        }
      },
      async getScanPolicies(
        this: ILoadOptionsFunctions,
        filter?: string,
      ): Promise<INodeListSearchResult> {
        try {
          let credentials;
          try {
            credentials = await this.getCredentials("guardfulaiApi");
          } catch {
            throw contractError("credentials_required");
          }
          const origin = normalizeOrigin(credentials.serviceOrigin);
          const response =
            (await this.helpers.httpRequestWithAuthentication.call(
              this,
              "guardfulaiApi",
              {
                method: "GET",
                url: `${origin}/v1/scan-policies`,
                json: true,
                returnFullResponse: true,
                ignoreHttpStatusErrors: true,
                timeout: REQUEST_TIMEOUT_MS,
              },
            )) as HttpResponse;
          if (response.statusCode !== 200) throw requestError(response);
          if (
            !Array.isArray(response.body) ||
            response.body.some(
              (option) =>
                !option ||
                typeof option !== "object" ||
                typeof option.id !== "string" ||
                !/^[0-9a-f-]{36}$/i.test(option.id) ||
                typeof option.name !== "string" ||
                !Number.isSafeInteger(option.current_version) ||
                option.current_version < 1 ||
                (option.credits_per_short_scan !== null &&
                  (!Number.isFinite(option.credits_per_short_scan) ||
                    option.credits_per_short_scan < 0)) ||
                !["input", "output"].includes(option.direction) ||
                typeof option.processing_mode !== "string" ||
                typeof option.pricing_version !== "string",
            )
          )
            throw contractError("invalid_api_response");
          const policies = response.body as PolicyOption[];
          return {
            results: policies
              .filter(
                (option) =>
                  (!filter ||
                    option.name.toLowerCase().includes(filter.toLowerCase())),
              )
              .map((option) => ({
                name: `${option.name} — v${option.current_version}${option.credits_per_short_scan === null ? "" : `, ${option.credits_per_short_scan} credit${option.credits_per_short_scan === 1 ? "" : "s"}`}`,
                value: `${option.id}::${option.current_version}`,
                description: `${option.direction}; ${option.processing_mode}; ${option.pricing_version}`,
              })),
          };
        } catch (error) {
          throw operationError(
            this.getNode(),
            error,
            undefined,
            "integration_transport_error",
          );
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    let origin: string;
    let operation: string;
    let concurrency: number;
    try {
      let credentials;
      try {
        credentials = await this.getCredentials("guardfulaiApi");
      } catch {
        throw contractError("credentials_required");
      }
      origin = normalizeOrigin(credentials.serviceOrigin);
      operation = this.getNodeParameter(
        "operation",
        0,
        "checkContent",
      ) as string;
      concurrency =
        operation === "checkContent"
          ? (this.getNodeParameter("concurrency", 0) as number)
          : 1;
      if (
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 8
      )
        throw contractError("concurrency_invalid");
    } catch (error) {
      throw operationError(this.getNode(), error);
    }
    const request: Requester = async (requestOptions) => {
      const options: IHttpRequestOptions = {
        url: `${origin}${requestOptions.url}`,
        method: requestOptions.method,
        headers: requestOptions.headers,
        body: requestOptions.body,
        json: true,
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        timeout: REQUEST_TIMEOUT_MS,
      };
      const response = await this.helpers.httpRequestWithAuthentication.call(
        this,
        "guardfulaiApi",
        options,
      );
      return response as unknown as HttpResponse;
    };

    if (operation !== "checkContent") {
      try {
        const result = await datasetSetup(request, {
          operation,
          name: this.getNodeParameter(operation === "setupDatasetRun" ? "batchDatasetName" : "datasetName", 0, "") as string,
          basis: this.getNodeParameter("reportingBasis", 0, "events") as string,
          dataset: operation === "setupDatasetRun" ? (this.getNodeParameter("batchDataset", 0, { value: "" }) as { value: string }).value : this.getNodeParameter("datasetId", 0, "") as string,
          destination: this.getNodeParameter("datasetDestination", 0, "new") as string,
          expectedRecords: operation === "setupDatasetRun" ? this.getNodeParameter("expectedRecords", 0, 0) as number : undefined,
          externalId: this.getNodeParameter("runIdentity", 0, "") as string,
          page: this.getNodeParameter("datasetPage", 0, 1) as number,
        });
        return [[{ json: { ...result, ...(result.report_url ? { report_url: `${origin}${result.report_url}` } : {}) } as IDataObject, pairedItem: { item: 0 } }]];
      } catch (error) {
        throw operationError(this.getNode(), error, 0, "dataset_setup_failed");
      }
    }
    const contexts = items.map((_item, index) => reportingContext(this.getNodeParameter("reporting", index, "")));
    let batch: Record<string, unknown> | undefined;
    const count = items.filter((_item, index) => String(this.getNodeParameter("content", index, "")).trim()).length;
    if (count > 1) {
      try {
        const explicit = contexts.filter(value => value !== undefined);
        if (explicit.length && (explicit.length !== contexts.length || explicit.some(value => value.dataset_id !== explicit[0].dataset_id || value.run_id !== explicit[0].run_id))) throw contractError("dataset_destination_conflict");
        if (explicit[0]?.run_id) {
          batch = { dataset_id: explicit[0].dataset_id, run_id: explicit[0].run_id, report_url: `/app/datasets/${explicit[0].dataset_id}/?run_id=${explicit[0].run_id}` };
        } else {
          const selection = this.getNodeParameter("batchDataset", 0, { value: "" }) as { value: string };
          // Existing event IDs are the node's retry authority. Fresh event IDs
          // identify a fresh batch; credentials and content never enter metadata.
          const identity = createHash("sha256").update(JSON.stringify([this.getNode().id, items.map((_item, index) => this.getNodeParameter("eventId", index))])).digest("hex");
          batch = await datasetSetup(request, {
            operation: "setupDatasetRun", externalId: `n8n:${identity}`, expectedRecords: count,
            destination: explicit[0] ? "existing" : this.getNodeParameter("datasetDestination", 0, "new") as string,
            dataset: explicit[0]?.dataset_id || selection.value,
            name: this.getNodeParameter("batchDatasetName", 0, "") as string,
          });
        }
      } catch (error) { throw operationError(this.getNode(), error, undefined, "dataset_setup_failed"); }
    }
    const output = await runBounded(
      items,
      concurrency,
      async (_item, itemIndex) => {
        try {
          const { policyId, policyVersion } = parsePolicySelection(
            this.getNodeParameter("scanPolicy", itemIndex),
          );
          const content = this.getNodeParameter("content", itemIndex) as string;
          const eventId = this.getNodeParameter("eventId", itemIndex) as string;
          const context = this.getNodeParameter(
            "context",
            itemIndex,
            "",
          ) as string;
          const direction = this.getNodeParameter("direction", itemIndex) as
            | "input"
            | "output";
          const returnRedactedContent = this.getNodeParameter(
            "returnRedactedContent",
            itemIndex,
          ) as boolean;
          const outputMode = this.getNodeParameter(
            "output",
            itemIndex,
            "simplified",
          );
          const outputFields = this.getNodeParameter(
            "outputFields",
            itemIndex,
            [],
          );
          validateOutputOptions(outputMode, outputFields);
          const options = this.getNodeParameter("options", itemIndex, {}) as {
            inputRetentionDays?: number;
            includeInput?: string;
          };
          const retention = options.inputRetentionDays ?? -1;
          const visibility = options.includeInput ?? "default";
          if (![-1, 0, 1, 7, 30].includes(retention))
            throw contractError("input_retention_invalid");
          if (!["default", "true", "false"].includes(visibility))
            throw contractError("include_input_invalid");
          const result = await checkContent(request, {
            content,
            context: context || undefined,
            structuredFields: this.getNodeParameter(
              "structuredFields",
              itemIndex,
              "",
            ),
            direction,
            eventId,
            itemIndex,
            policyId,
            policyVersion,
            returnRedactedContent,
            inputRetentionDays: retention === -1 ? undefined : retention,
            includeInput:
              visibility === "default"
                ? outputMode === "selected" &&
                  Array.isArray(outputFields) &&
                  outputFields.includes("input")
                  ? true
                  : undefined
                : visibility === "true",
            reporting: batch ? {
              ...contexts[itemIndex], dataset_id: String(batch.dataset_id), run_id: String(batch.run_id),
              record_id: contexts[itemIndex]?.record_id || `item:${itemIndex}`,
            } : contexts[itemIndex],
          });
          return {
            json: { ...selectOutput(result, outputMode, outputFields), ...(batch ? { dataset_id: batch.dataset_id, run_id: batch.run_id, dataset_name: batch.dataset_name, report_url: `${origin}${batch.report_url}` } : {}) } as IDataObject,
            pairedItem: { item: itemIndex },
          };
        } catch (error) {
          if (this.continueOnFail()) {
            const detail = presentError(error);
            return {
              json: {
                status: "error",
                safe_to_continue: false,
                guardfulai_error: detail,
                ...(batch ? { dataset_id: batch.dataset_id, run_id: batch.run_id, dataset_name: batch.dataset_name, report_url: `${origin}${batch.report_url}` } : {}),
              } as IDataObject,
              pairedItem: { item: itemIndex },
            };
          }
          if (batch) {
            const detail = presentError(error);
            throw new NodeOperationError(this.getNode(), `${detail.message} (${detail.code})`, { description: `${detail.description} View dataset report: ${origin}${batch.report_url}`, itemIndex });
          }
          throw operationError(this.getNode(), error, itemIndex);
        }
      },
    );
    return [output];
  }
}
