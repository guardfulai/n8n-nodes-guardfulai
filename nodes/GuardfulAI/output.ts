import { GuardfulAIContractError } from "./errors";

const core = ["scan_id", "status", "decision", "safe_to_continue"];
const simplified = [
  ...core,
  "scan_policy_version",
  "flagged",
  "redacted",
  "redacted_content",
  "replayed",
  "usage",
];
export const OUTPUT_FIELDS = [
  { name: "Original Input", value: "input" },
  { name: "Input Availability", value: "input_state" },
  { name: "Input Retention", value: "input_retention" },
  { name: "Check Summaries", value: "check_summaries" },
  { name: "Findings", value: "findings" },
  { name: "Flagged", value: "flagged" },
  { name: "Redacted", value: "redacted" },
  { name: "Redacted Content", value: "redacted_content" },
  { name: "Replayed", value: "replayed" },
  { name: "Runtime Bundle", value: "runtime_bundle" },
  { name: "Scan Policy Version", value: "scan_policy_version" },
  { name: "Semantic Assessments", value: "semantic_assessments" },
  { name: "Semantic Coverage", value: "semantic_coverage" },
  { name: "Usage", value: "usage" },
];
export function validateOutputOptions(mode: unknown, fields: unknown): void {
  if (mode !== "raw" && mode !== "simplified" && mode !== "selected")
    throw new GuardfulAIContractError("output_mode_invalid");
  if (
    mode === "selected" &&
    (!Array.isArray(fields) ||
      fields.some(
        (field) => !OUTPUT_FIELDS.some((option) => option.value === field),
      ))
  )
    throw new GuardfulAIContractError("output_fields_invalid");
}
export function selectOutput(
  result: Record<string, unknown>,
  mode: unknown,
  fields: unknown,
): Record<string, unknown> {
  validateOutputOptions(mode, fields);
  if (mode === "raw") return result;
  const keys =
    mode === "simplified" ? simplified : [...core, ...(fields as string[])];
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(result, key))
      .map((key) => [key, result[key]]),
  );
}
