/** Content-free reporting validation, vendored identically in Zapier. */
export interface ReportingContext {
  dataset_id: string;
  record_id: string;
  run_id?: string;
  event_at?: string;
  event_date?: string;
  dimensions?: Record<string, string>;
  event_time_invalid?: boolean;
}

function invalid(): never {
  throw new TypeError("reporting_input_invalid");
}

export function datasetId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  )
    invalid();
  return value.toLowerCase();
}

function literal(value: unknown, maximum: number): string {
  if (typeof value !== "string" || Array.from(value).length > maximum)
    invalid();
  try {
    encodeURIComponent(value);
  } catch {
    invalid();
  }
  return value;
}

export function recordId(value: unknown): string {
  const result = literal(value, 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) invalid();
  return result;
}

export function eventDate(value: unknown): string {
  const result = literal(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || result.startsWith("0000"))
    invalid();
  const instant = new Date(`${result}T00:00:00Z`);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== result
  )
    invalid();
  return result;
}

export function reportingContext(input: unknown): ReportingContext | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      invalid();
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const source = value as Record<string, unknown>;
  const allowed = [
    "schema_version",
    "dataset_id",
    "run_id",
    "record_id",
    "event_at",
    "event_date",
    "dimensions",
    "event_time_invalid",
  ];
  if (Object.keys(source).some((key) => !allowed.includes(key))) invalid();
  if (source.schema_version !== undefined && source.schema_version !== 1)
    invalid();
  const result: ReportingContext = {
    dataset_id: datasetId(source.dataset_id),
    record_id: recordId(source.record_id),
  };
  if (source.run_id != null) result.run_id = datasetId(source.run_id);
  if (source.event_date != null)
    result.event_date = eventDate(source.event_date);
  if (source.event_at != null) {
    if (result.event_date !== undefined) invalid();
    const instant = literal(source.event_at, 64);
    const parts =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(
        instant,
      );
    if (
      !parts ||
      Number(parts[2]) > 23 ||
      Number(parts[3]) > 59 ||
      Number(parts[4] || "0") > 59
    )
      invalid();
    eventDate(parts[1]);
    const offset = parts[5];
    if (!offset) invalid();
    if (
      offset !== "Z" &&
      (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)
    )
      invalid();
    if (!Number.isFinite(Date.parse(instant))) invalid();
    result.event_at = instant;
  }
  if (source.dimensions != null) {
    if (
      typeof source.dimensions !== "object" ||
      Array.isArray(source.dimensions)
    )
      invalid();
    const entries = Object.entries(source.dimensions);
    if (entries.length > 8) invalid();
    result.dimensions = {};
    for (const [key, val] of entries) {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(key)) invalid();
      result.dimensions[key] = literal(val, 160);
    }
    // Match Python's default JSON separators in the sealed byte limit.
    const bytes =
      Buffer.byteLength(JSON.stringify(result.dimensions), "utf8") +
      Math.max(0, entries.length * 2 - 1);
    if (bytes > 2000) invalid();
  }
  if (source.event_time_invalid !== undefined) {
    if (typeof source.event_time_invalid !== "boolean") invalid();
    if (source.event_time_invalid) {
      if (result.event_date !== undefined || result.event_at !== undefined)
        invalid();
      result.event_time_invalid = true;
    }
  }
  return result;
}

export function datasetWrite(
  name: unknown,
  basis: unknown,
): { name: string; reporting_basis: "events" | "latest_run" } {
  const checked = literal(name, 120);
  if (!checked.trim() || (basis !== "events" && basis !== "latest_run"))
    invalid();
  return { name: checked, reporting_basis: basis };
}

export function datasetProjection(value: unknown): {
  id: string;
  name: string;
  reporting_basis: "events" | "latest_run";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const result = datasetWrite(row.name, row.reporting_basis);
  return { id: datasetId(row.id), ...result };
}
