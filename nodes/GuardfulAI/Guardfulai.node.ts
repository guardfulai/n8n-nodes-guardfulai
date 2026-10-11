import type {
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
import { selectOutput, validateOutputOptions, OUTPUT_FIELDS } from "./output";

import {
  GuardfulAIRequestError,
  checkContent,
  normalizeOrigin,
  parsePolicySelection,
  REQUEST_TIMEOUT_MS,
  type HttpResponse,
  type PolicyOption,
  type Requester,
  runBounded,
} from "./transport";

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
    credentials: [{ name: "guardfulaiApi", required: true }],
    properties: [
      {
        displayName: "Input Retention",
        name: "inputRetentionDays",
        type: "options",
        default: -1,
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
        options: [
          { name: "Organization Default", value: "default" },
          { name: "Show", value: "true" },
          { name: "Hide", value: "false" },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Check Content",
            value: "checkContent",
            action: "Check content",
          },
          {
            name: "List Datasets",
            value: "listDatasets",
            action: "List datasets",
          },
          {
            name: "Create Dataset",
            value: "createDataset",
            action: "Create a dataset",
          },
          {
            name: "Create Dataset Run",
            value: "createDatasetRun",
            action: "Create or recover a dataset run",
          },
        ],
        default: "checkContent",
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
          "Choose a priced policy version from the list, or enter its ID and version",
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
              "Return the decision, identity, redaction and usage fields",
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
        displayOptions: { show: { operation: ["createDatasetRun"] } },
        description:
          "Stable opaque batch ID. Reuse on retry; use a new ID for an intentional new snapshot.",
      },
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
    listSearch: {
      async getScanPolicies(
        this: ILoadOptionsFunctions,
        filter?: string,
      ): Promise<INodeListSearchResult> {
        const credentials = await this.getCredentials("guardfulaiApi");
        const origin = normalizeOrigin(credentials.serviceOrigin);
        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          "guardfulaiApi",
          {
            method: "GET",
            url: `${origin}/v1/scan-policies`,
            json: true,
            timeout: REQUEST_TIMEOUT_MS,
          },
        )) as PolicyOption[];
        return {
          results: response
            .filter(
              (option) =>
                option.credits_per_short_scan !== null &&
                (!filter ||
                  option.name.toLowerCase().includes(filter.toLowerCase())),
            )
            .map((option) => ({
              name: `${option.name} — v${option.current_version}, ${option.credits_per_short_scan} credit${option.credits_per_short_scan === 1 ? "" : "s"}`,
              value: `${option.id}::${option.current_version}`,
              description: `${option.direction}; ${option.processing_mode}; ${option.pricing_version}`,
            })),
        };
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const credentials = await this.getCredentials("guardfulaiApi");
    const origin = normalizeOrigin(credentials.serviceOrigin);
    const operation = this.getNodeParameter(
      "operation",
      0,
      "checkContent",
    ) as string;
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
      const result = await datasetSetup(request, {
        operation,
        name: this.getNodeParameter("datasetName", 0, "") as string,
        basis: this.getNodeParameter("reportingBasis", 0, "events") as string,
        dataset: this.getNodeParameter("datasetId", 0, "") as string,
        externalId: this.getNodeParameter("runIdentity", 0, "") as string,
        page: this.getNodeParameter("datasetPage", 0, 1) as number,
      });
      return [[{ json: result as IDataObject, pairedItem: { item: 0 } }]];
    }
    const concurrency = this.getNodeParameter("concurrency", 0) as number;

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
            inputRetentionDays:
              this.getNodeParameter("inputRetentionDays", itemIndex, -1) === -1
                ? undefined
                : (this.getNodeParameter(
                    "inputRetentionDays",
                    itemIndex,
                  ) as number),
            includeInput:
              this.getNodeParameter("includeInput", itemIndex, "default") ===
              "default"
                ? outputMode === "selected" &&
                  Array.isArray(outputFields) &&
                  outputFields.includes("input")
                  ? true
                  : undefined
                : this.getNodeParameter("includeInput", itemIndex) === "true",
            reporting: this.getNodeParameter(
              "reporting",
              itemIndex,
              "",
            ) as string,
          });
          return {
            json: selectOutput(result, outputMode, outputFields) as IDataObject,
            pairedItem: { item: itemIndex },
          };
        } catch (error) {
          if (this.continueOnFail()) {
            const detail =
              error instanceof GuardfulAIRequestError
                ? {
                    status: error.status,
                    code: error.code,
                    retryable: error.retryable,
                  }
                : { status: null, code: "integration_error", retryable: false };
            return {
              json: {
                status: "error",
                safe_to_continue: false,
                guardfulai_error: detail,
              },
              pairedItem: { item: itemIndex },
            };
          }
          throw new NodeOperationError(
            this.getNode(),
            error instanceof Error
              ? error
              : new Error("Guardful AI integration error"),
            { itemIndex },
          );
        }
      },
    );
    return [output];
  }
}
