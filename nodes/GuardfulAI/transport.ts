import { createHash } from "node:crypto";

import { sleep } from "n8n-workflow";

import { reportingContext, type ReportingContext } from "./reporting";

export interface PolicyOption {
  id: string;
  name: string;
  current_version: number;
  direction: "input" | "output";
  processing_mode: "local_only";
  credits_per_short_scan: number | null;
  pricing_version: string;
}

export interface CheckInput {
  content: string;
  context?: string;
  structuredFields?: unknown;
  direction: "input" | "output";
  eventId: string;
  itemIndex: number;
  policyId: string;
  policyVersion: number;
  returnRedactedContent: boolean;
  inputRetentionDays?: number;
  includeInput?: boolean;
  reporting?: ReportingContext | string;
}

export interface HttpResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

export type Requester = (request: {
  method: "POST" | "GET";
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}) => Promise<HttpResponse>;

type JsonObject = Record<string, unknown>;
export const REQUEST_TIMEOUT_MS = 30_000;

class GuardfulAIContractError extends Error {}

function failContract(code: string): never {
  const error = new GuardfulAIContractError(code);
  throw error;
}

export class GuardfulAIRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`Guardful AI request failed (${status}: ${code})`);
    this.name = "GuardfulAIRequestError";
  }
}

export function normalizeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    failContract("service_origin_required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    failContract("service_origin_invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    failContract("service_origin_invalid");
  }
  return parsed.origin;
}

export function parsePolicySelection(value: unknown): {
  policyId: string;
  policyVersion: number;
} {
  if (value !== null && typeof value === "object" && "value" in value) {
    value = (value as { value: unknown }).value;
  }
  if (typeof value !== "string") failContract("scan_policy_required");
  const match = /^([0-9a-f-]{36})::([1-9][0-9]*)$/i.exec(value);
  if (!match) failContract("scan_policy_invalid");
  return { policyId: match[1], policyVersion: Number(match[2]) };
}

export function stableRetryKey(input: CheckInput): string {
  if (
    !input.eventId ||
    !Number.isSafeInteger(input.itemIndex) ||
    input.itemIndex < 0
  ) {
    failContract("stable_source_event_required");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "n8n",
        input.eventId,
        input.itemIndex,
        input.policyId,
        input.policyVersion,
      ]),
    )
    .digest("hex");
  return `guardfulai:n8n:${digest}`;
}

function record(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failContract("invalid_api_response");
  }
  return value as JsonObject;
}

export function parseStructuredFields(value: unknown): JsonObject | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      failContract("structured_fields_invalid");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    failContract("structured_fields_invalid");
  }
  const fields = parsed as JsonObject;
  if (
    Object.keys(fields).length > 16 ||
    Object.values(fields).some(
      (item) =>
        item !== null &&
        typeof item !== "string" &&
        typeof item !== "boolean" &&
        !(typeof item === "number" && Number.isFinite(item)),
    )
  ) {
    failContract("structured_fields_invalid");
  }
  if (Array.from(JSON.stringify(fields)).length > 2000) {
    failContract("structured_fields_invalid");
  }
  return { ...fields };
}

function semanticOutput(
  result: JsonObject,
  findings: JsonObject[],
): JsonObject {
  const rows = result.semantic_assessments;
  const rawCoverage = result.semantic_coverage;
  if (rows == null && rawCoverage == null) return {};
  const invalid = (): never => {
    return failContract("invalid_semantic_result");
  };
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 16 ||
    !Array.isArray(result.checks_run) ||
    !result.checks_run.includes("custom.semantic_policy")
  )
    return invalid();
  const coverage = record(rawCoverage);
  if (
    coverage.schema_version !== 1 ||
    coverage.expected !== rows.length ||
    coverage.completed !== rows.length
  )
    return invalid();
  const reasons: Record<string, string[]> = {
    compliant: ["no_match"],
    violated: ["policy_match"],
    uncertain: ["ambiguous", "insufficient_context", "conflicting_policy"],
  };
  const ids = new Set<string>();
  if (
    result.flagged !== findings.length > 0 ||
    findings.some(
      (finding) =>
        ![
          "monitor",
          "review",
          "block",
          "redact_and_allow",
          "redact_and_review",
        ].includes(String(finding.action)),
    )
  )
    return invalid();
  const decision = findings.some((finding) => finding.action === "block")
    ? "block"
    : findings.some((finding) =>
          ["review", "redact_and_review"].includes(String(finding.action)),
        )
      ? "review"
      : "allow";
  if (result.decision !== decision) return invalid();
  const assessments = rows.map((item) => {
    const row = record(item);
    if (
      row.schema_version !== 1 ||
      typeof row.policy_id !== "string" ||
      !/^[a-z][a-z0-9_]{0,47}$/.test(row.policy_id) ||
      ids.has(row.policy_id) ||
      typeof row.outcome !== "string" ||
      typeof row.reason_code !== "string" ||
      !Object.hasOwn(reasons, row.outcome) ||
      !reasons[row.outcome]?.includes(row.reason_code)
    )
      return invalid();
    ids.add(row.policy_id);
    const matches = findings.filter(
      (finding) =>
        finding.check_key === "custom.semantic_policy" &&
        finding.rule_id === row.policy_id,
    );
    if (row.outcome === "compliant") {
      if (matches.length) return invalid();
    } else {
      const match = matches[0];
      if (
        matches.length !== 1 ||
        !match ||
        match.code !== `policy_${row.outcome}` ||
        match.reason_code !== row.reason_code
      )
        return invalid();
      if (
        row.outcome === "uncertain" &&
        (match.action !== "review" || result.decision === "allow")
      )
        return invalid();
    }
    return {
      schema_version: 1,
      policy_id: row.policy_id,
      outcome: row.outcome,
      reason_code: row.reason_code,
    };
  });
  if (
    findings.some(
      (finding) =>
        finding.check_key === "custom.semantic_policy" &&
        (typeof finding.rule_id !== "string" || !ids.has(finding.rule_id)),
    )
  )
    return invalid();
  return {
    semantic_assessments: assessments,
    semantic_coverage: {
      schema_version: 1,
      expected: rows.length,
      completed: rows.length,
    },
  };
}

function inputOutput(result: JsonObject): JsonObject {
  const output: JsonObject = {};
  if (result.input !== undefined) {
    const input = record(result.input);
    if (
      typeof input.content !== "string" ||
      input.content.length > 20000 ||
      !["input", "output"].includes(String(input.direction))
    )
      failContract("invalid_input_result");
    output.input = input;
  }
  if (result.input_state !== undefined) {
    if (
      ![
        "available",
        "hidden",
        "not_retained",
        "expired",
        "unavailable",
      ].includes(String(result.input_state))
    )
      failContract("invalid_input_result");
    output.input_state = result.input_state;
  }
  if (result.input_retention !== undefined)
    output.input_retention = record(result.input_retention);
  return output;
}

function projectOutput(body: unknown): JsonObject {
  const result = record(body);
  if (
    result.schema_version !== 1 ||
    typeof result.scan_id !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(result.scan_id) ||
    typeof result.flagged !== "boolean" ||
    typeof result.redacted !== "boolean" ||
    result.status !== "completed" ||
    !["allow", "review", "block"].includes(String(result.decision)) ||
    typeof result.safe_to_continue !== "boolean" ||
    result.safe_to_continue !== (result.decision === "allow") ||
    !Array.isArray(result.checks_run) ||
    !Array.isArray(result.findings)
  ) {
    failContract("invalid_completed_result");
  }
  const findings = result.findings.map(record);
  const checks = result.checks_run;
  if (
    result.checks_run.some((key) => typeof key !== "string") ||
    result.flagged !== findings.length > 0 ||
    findings.some(
      (finding) =>
        !checks.includes(finding.check_key) ||
        ![
          "monitor",
          "review",
          "block",
          "redact_and_allow",
          "redact_and_review",
        ].includes(String(finding.action)),
    )
  ) {
    failContract("invalid_completed_result");
  }
  const expectedDecision = findings.some(
    (finding) => finding.action === "block",
  )
    ? "block"
    : findings.some((finding) =>
          ["review", "redact_and_review"].includes(String(finding.action)),
        )
      ? "review"
      : "allow";
  if (result.decision !== expectedDecision)
    failContract("invalid_completed_result");

  const checkSummaries = result.checks_run.map((checkKey) => {
    const selected = findings.filter(
      (finding) => finding.check_key === checkKey,
    );
    return {
      check_key: checkKey,
      flagged: selected.length > 0,
      finding_count: selected.length,
      actions: [...new Set(selected.map((finding) => finding.action))],
    };
  });
  return {
    scan_id: result.scan_id,
    status: result.status,
    decision: result.decision,
    safe_to_continue: result.safe_to_continue,
    flagged: result.flagged,
    redacted: result.redacted,
    redacted_content: result.redacted_content ?? null,
    ...inputOutput(result),
    check_summaries: checkSummaries,
    findings,
    ...semanticOutput(result, findings),
    scan_policy_version: result.scan_policy_version,
    runtime_bundle: result.runtime_bundle,
    usage: result.usage,
    replayed: result.replayed,
  };
}

function errorFrom(response: HttpResponse): GuardfulAIRequestError {
  const body = record(response.body);
  return new GuardfulAIRequestError(
    response.statusCode,
    typeof body.code === "string" ? body.code : "integration_transport_error",
    body.retryable === true &&
      [409, 429, 503, 504].includes(response.statusCode),
  );
}

function retryDelay(response: HttpResponse): number {
  const value = response.headers?.["retry-after"];
  const seconds = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, 5000)
    : 1000;
}

function transportError(): GuardfulAIRequestError {
  return new GuardfulAIRequestError(503, "integration_transport_error", true);
}

export async function checkContent(
  request: Requester,
  input: CheckInput,
  wait: (milliseconds: number) => Promise<void> = sleep,
): Promise<JsonObject> {
  const payload: Record<string, unknown> = {
    content: input.content,
    scan_policy_id: input.policyId,
    scan_policy_version: input.policyVersion,
    direction: input.direction,
    external_id: input.eventId.slice(0, 64),
    return_redacted_content: input.returnRedactedContent,
  };
  if (input.inputRetentionDays !== undefined) {
    if (![0, 1, 7, 30].includes(input.inputRetentionDays))
      throw new TypeError("input_retention_invalid");
    payload.input_retention_days = input.inputRetentionDays;
  }
  if (input.includeInput !== undefined)
    payload.include_input = input.includeInput;
  if (input.context) payload.context = input.context;
  const fields = parseStructuredFields(input.structuredFields);
  if (fields !== undefined) payload.structured_fields = fields;
  const reporting = reportingContext(input.reporting);
  if (reporting !== undefined) payload.reporting = reporting;

  for (let attempt = 0; attempt < 3; attempt++) {
    let response: HttpResponse;
    try {
      response = await request({
        method: "POST",
        url: "/v1/check",
        headers: { "Idempotency-Key": stableRetryKey(input) },
        body: payload,
      });
    } catch {
      if (attempt === 2) {
        throw transportError();
      }
      await wait(1000);
      continue;
    }
    if (response.statusCode === 200) {
      const output = projectOutput(response.body);
      if (output.scan_policy_version !== input.policyVersion)
        failContract("policy_version_mismatch");
      return output;
    }
    const error = errorFrom(response);
    if (!error.retryable || attempt === 2) throw error;
    await wait(retryDelay(response));
  }
  return failContract("retry_loop_exhausted");
}

export async function runBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8
  ) {
    failContract("concurrency_invalid");
  }
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return results;
}
