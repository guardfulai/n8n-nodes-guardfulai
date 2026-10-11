import {
  datasetId,
  datasetProjection,
  datasetWrite,
  recordId,
} from "./reporting";
import { contractError, GuardfulAIRequestError, requestError } from "./errors";
import type { Requester, HttpResponse } from "./transport";

export interface DatasetSetupInput {
  operation: string;
  name?: string;
  basis?: string;
  dataset?: string;
  externalId?: string;
  page?: number;
}

function setupValue<T>(read: () => T, code: string): T {
  try {
    return read();
  } catch {
    throw contractError(code);
  }
}

export async function datasetSetup(
  request: Requester,
  input: DatasetSetupInput,
): Promise<Record<string, unknown>> {
  let url = "/v1/datasets";
  let body: Record<string, unknown> | undefined;
  if (input.operation === "listDatasets") {
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new GuardfulAIRequestError(422, "dataset_page_invalid", false);
    url += `?page=${page}&page_size=50`;
  } else if (input.operation === "createDataset") {
    body = setupValue(
      () => datasetWrite(input.name, input.basis),
      "dataset_parameters_invalid",
    );
  } else if (input.operation === "createDatasetRun") {
    url += `/${setupValue(() => datasetId(input.dataset), "dataset_id_invalid")}/runs`;
    body = {
      external_id: setupValue(
        () => recordId(input.externalId),
        "run_identity_invalid",
      ),
      source_kind: "n8n",
    };
  } else {
    throw new GuardfulAIRequestError(422, "dataset_operation_invalid", false);
  }
  // Setup never scans. An uncertain create is resolved by listing/selecting;
  // an uncertain run is recovered by invoking the same immutable external ID.
  let response: HttpResponse;
  try {
    response = await request({
      method: body ? "POST" : "GET",
      url,
      headers: {},
      body,
    });
  } catch {
    throw requestError({
      statusCode: 503,
      body: { code: "integration_transport_error" },
    });
  }
  if (![200, 201].includes(response.statusCode)) {
    const error = requestError(response, "dataset_setup_failed");
    throw new GuardfulAIRequestError(error.status, error.code, false);
  }
  if (
    !response.body ||
    typeof response.body !== "object" ||
    Array.isArray(response.body)
  )
    throw new GuardfulAIRequestError(502, "dataset_response_invalid", false);
  const data = response.body as Record<string, unknown>;
  if (input.operation === "listDatasets") {
    if (
      !Array.isArray(data.datasets) ||
      data.datasets.length > 50 ||
      !Number.isSafeInteger(data.total)
    )
      throw new GuardfulAIRequestError(502, "dataset_response_invalid", false);
    return {
      datasets: setupValue(
        () => (data.datasets as unknown[]).map(datasetProjection),
        "dataset_response_invalid",
      ),
      total: data.total,
      page: input.page ?? 1,
      credits_consumed: 0,
    };
  }
  if (input.operation === "createDatasetRun") {
    if (
      data.dataset_id !== input.dataset?.toLowerCase() ||
      data.external_id !== input.externalId
    )
      throw new GuardfulAIRequestError(502, "dataset_response_invalid", false);
    return {
      ...setupValue(
        () => ({
          dataset_id: datasetId(data.dataset_id),
          run_id: datasetId(data.id),
          external_id: recordId(data.external_id),
        }),
        "dataset_response_invalid",
      ),
      credits_consumed: 0,
    };
  }
  return {
    ...setupValue(() => datasetProjection(data), "dataset_response_invalid"),
    credits_consumed: 0,
  };
}
