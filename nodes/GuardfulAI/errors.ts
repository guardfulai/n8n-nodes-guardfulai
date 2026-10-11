/** Fixed user-facing copy; never display service bodies or helper exceptions. */
const guidance = {
  credentials: {
    message: "Guardful AI could not authenticate the credential",
    description:
      "Replace the API key in the Guardful AI API credential with a valid, unexpired key, then test the connection.",
  },
  access: {
    message: "The integration key cannot access this operation or policy",
    description:
      "Check the key's allowed operations and Scan Policies in Guardful AI Integration keys. Credential testing needs auth:test; policy selection needs scan_policies:read; checking needs scan:check. Dataset setup needs the corresponding datasets scope and unrestricted policy access for writes.",
  },
  credits: {
    message: "Guardful AI has insufficient available credits",
    description:
      "Open Usage in your Guardful AI workspace and check available credits before retrying the same request.",
  },
  policy: {
    message: "The selected Scan Policy version is unavailable or invalid",
    description:
      "Refresh 'Scan Policy' and choose an accessible published version, or enter its ID::version using 'By ID'. Check that 'Direction' matches the policy. Review changed inputs and cost before using a new event identity.",
  },
  transport: {
    message: "Guardful AI could not be reached or did not complete the request",
    description:
      "Check 'Service Origin' and connectivity from the n8n host. For Check Content, retry with the same Source Event ID, item order and request values. For an uncertain dataset creation, use List Datasets before creating again; recover a dataset run with the same Run Identity.",
  },
  conflict: {
    message: "This request identity already belongs to another request",
    description:
      "Restore the original request values and item order for a retry. Use a new Source Event ID only for an intentional new event after reviewing its cost; recover a dataset run with its original Run Identity.",
  },
  dataset: {
    message: "Guardful AI could not complete dataset setup",
    description:
      "Check the dataset parameters and the key's datasets permissions. After an uncertain Create Dataset response, use List Datasets before creating again. Recover Create Dataset Run with the same Dataset ID and Run Identity.",
  },
  response: {
    message: "Guardful AI returned an incomplete or unexpected response",
    description:
      "Keep downstream actions stopped. Contact Guardful AI support with the sanitized code and node version; do not share credentials or scanned content.",
  },
  origin: {
    message: "The Service Origin is missing or invalid",
    description:
      "Set 'Service Origin' in the Guardful AI API credential to a reachable HTTPS origin without a path, query or fragment. Plain HTTP is permitted only for loopback development.",
  },
  generic: {
    message: "Guardful AI could not complete the operation",
    description:
      "Check the node parameters and credential. If the issue persists, contact Guardful AI support with the sanitized code and node version; do not share credentials or scanned content.",
  },
};

const groups: Record<string, keyof typeof guidance> = {};
for (const [group, codes] of Object.entries({
  credentials: [
    "invalid_key",
    "invalid_api_key",
    "authentication_required",
    "credentials_required",
  ],
  access: [
    "scope_denied",
    "scope_required",
    "dataset_management_requires_unrestricted_policy",
    "policy_access_denied",
    "permission_denied",
    "forbidden",
  ],
  credits: ["insufficient_credits"],
  policy: [
    "scan_policy_required",
    "scan_policy_invalid",
    "scan_policy_not_found",
    "not_found",
    "policy_mismatch",
    "checks_unavailable",
    "scan_policy_version_not_found",
    "policy_version_mismatch",
    "policy_unavailable",
    "direction_mismatch",
  ],
  transport: [
    "integration_transport_error",
    "runtime_unavailable",
    "in_progress",
    "rate_limited",
    "service_unavailable",
    "scan_failed",
    "detector_timeout",
  ],
  conflict: ["idempotency_conflict"],
  dataset: [
    "dataset_setup_failed",
    "dataset_operation_invalid",
    "dataset_page_invalid",
    "dataset_not_found",
    "dataset_run_not_found",
  ],
  response: [
    "invalid_api_response",
    "invalid_completed_result",
    "invalid_semantic_result",
    "invalid_input_result",
    "dataset_response_invalid",
    "retry_loop_exhausted",
  ],
  origin: ["service_origin_required", "service_origin_invalid"],
  generic: ["integration_error", "invalid_request"],
})) {
  for (const code of codes) groups[code] = group as keyof typeof guidance;
}

const parameters: Record<string, [string, string]> = {
  dataset_parameters_invalid: [
    "Dataset Name / Reporting Basis",
    "Enter a nonempty Dataset Name of at most 120 characters and choose Events or Latest Run for Reporting Basis.",
  ],
  dataset_id_invalid: [
    "Dataset ID",
    "Choose an exact Dataset ID from List Datasets.",
  ],
  run_identity_invalid: [
    "Run Identity",
    "Use a stable opaque Run Identity of at most 128 characters using letters, digits, underscores, hyphens, periods or colons. Keep it unchanged on retry.",
  ],
  dataset_page_invalid: [
    "Page",
    "Choose a whole number from 1 through 100000.",
  ],
  stable_source_event_required: [
    "Source Event ID",
    "Use a stable, nonempty ID from the source event; keep it unchanged on retries.",
  ],
  structured_fields_invalid: [
    "Supplied Fields (JSON)",
    "Supply a JSON object with at most 16 scalar fields matching the policy's required types.",
  ],
  reporting_input_invalid: [
    "Dataset Reporting Context",
    "Check the dataset and record IDs, run identity, event date/time and dimensions. Dataset setup also needs a valid name, reporting basis and Run Identity.",
  ],
  input_retention_invalid: [
    "Input Retention",
    "Choose Organization Default, None, 1 Day, 7 Days or 30 Days in Options.",
  ],
  include_input_invalid: [
    "Original Input in Output",
    "Choose Organization Default, Show or Hide in Options.",
  ],
  output_mode_invalid: ["Output", "Choose Simplified, Raw or Selected Fields."],
  output_fields_invalid: [
    "Fields",
    "Choose available fields from the Selected Fields list.",
  ],
  concurrency_invalid: [
    "Concurrency",
    "Choose a whole number from 1 through 8.",
  ],
};

function knownCode(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    (Object.hasOwn(groups, value) || Object.hasOwn(parameters, value))
    ? value
    : fallback;
}

export class GuardfulAIContractError extends TypeError {}

export function contractError(code: string): GuardfulAIContractError {
  return new GuardfulAIContractError(code);
}

export class GuardfulAIRequestError extends Error {
  readonly code: string;
  constructor(
    readonly status: number,
    code: unknown,
    readonly retryable: boolean,
  ) {
    const safeCode = knownCode(code, "integration_error");
    super(`Guardful AI request failed (${status}: ${safeCode})`);
    this.code = safeCode;
    this.name = "GuardfulAIRequestError";
  }
}

export function requestError(
  response: { statusCode: number; body: unknown },
  fallback = "integration_transport_error",
): GuardfulAIRequestError {
  const body =
    response.body &&
    typeof response.body === "object" &&
    !Array.isArray(response.body)
      ? (response.body as Record<string, unknown>)
      : {};
  return new GuardfulAIRequestError(
    response.statusCode,
    knownCode(body.code, fallback),
    body.retryable === true &&
      [409, 429, 503, 504].includes(response.statusCode),
  );
}

export function presentError(error: unknown, fallback = "integration_error") {
  const status = error instanceof GuardfulAIRequestError ? error.status : null;
  const code =
    error instanceof GuardfulAIRequestError
      ? error.code
      : error instanceof TypeError || error instanceof GuardfulAIContractError
        ? knownCode(error.message, fallback)
        : fallback;
  const parameter = parameters[code];
  const group =
    status === 401
      ? "credentials"
      : status === 403
        ? "access"
        : status === 402
          ? "credits"
          : (groups[code] ??
            (status !== null && [429, 503, 504].includes(status)
              ? "transport"
              : "generic"));
  const copy = parameter
    ? {
        message: `The '${parameter[0]}' parameter is invalid`,
        description: parameter[1],
      }
    : guidance[group];
  return {
    status,
    code,
    retryable: error instanceof GuardfulAIRequestError && error.retryable,
    ...copy,
  };
}
