import {
  datasetId,
  datasetProjection,
  datasetWrite,
  recordId,
} from "./reporting";
import { GuardfulAIRequestError, type Requester } from "./transport";

export interface DatasetSetupInput {
  operation: string;
  name?: string;
  basis?: string;
  dataset?: string;
  externalId?: string;
  page?: number;
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
    body = datasetWrite(input.name, input.basis);
  } else if (input.operation === "createDatasetRun") {
    url += `/${datasetId(input.dataset)}/runs`;
    body = { external_id: recordId(input.externalId), source_kind: "n8n" };
  } else {
    throw new GuardfulAIRequestError(422, "dataset_operation_invalid", false);
  }
  // Setup never scans. An uncertain create is resolved by listing/selecting;
  // an uncertain run is recovered by invoking the same immutable external ID.
  const response = await request({
    method: body ? "POST" : "GET",
    url,
    headers: {},
    body,
  });
  if (![200, 201].includes(response.statusCode))
    throw new GuardfulAIRequestError(
      response.statusCode,
      "dataset_setup_failed",
      false,
    );
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
      datasets: data.datasets.map(datasetProjection),
      total: data.total,
      page: input.page ?? 1,
      credits_consumed: 0,
    };
  }
  if (input.operation === "createDatasetRun") {
    if (
      data.dataset_id !== datasetId(input.dataset) ||
      data.external_id !== input.externalId
    )
      throw new GuardfulAIRequestError(502, "dataset_response_invalid", false);
    return {
      dataset_id: datasetId(data.dataset_id),
      run_id: datasetId(data.id),
      external_id: recordId(data.external_id),
      credits_consumed: 0,
    };
  }
  return { ...datasetProjection(data), credits_consumed: 0 };
}
