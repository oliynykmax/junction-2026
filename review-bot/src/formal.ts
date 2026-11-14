export const VERIFICATION_METHODS = [
  "TLA+",
  "Dafny",
  "Verus",
  "Kani",
  "Gobra",
  "Nagini",
  "Frama-C",
  "CBMC",
  "property test",
  "other",
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const VERIFICATION_OUTCOMES = [
  "passed",
  "counterexample",
  "not_run",
] as const;

export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/**
 * The durable record behind the human-facing verification receipt. `result`
 * is agent-reported checker output. The runtime validates structure, not truth.
 */
export type VerificationReceipt = {
  id: string;
  files: string[];
  target: string;
  property: string;
  harm: string;
  method: VerificationMethod;
  checker: string;
  command: string;
  outcome: VerificationOutcome;
  result: string;
  scope: string;
  brokenVariant: string | null;
  assumptions: string[];
  limits: string[];
  fixCheck?: {
    command: string;
    before: string;
    after: string;
    outcome: "passed" | "failed";
  };
};

export type VerificationInput = Omit<
  VerificationReceipt,
  "id" | "brokenVariant" | "fixCheck"
> & {
  broken_variant?: string;
  fix_check?: {
    command: string;
    before: string;
    after: string;
    outcome: "passed" | "failed";
  };
};

const MAX_SHORT = 280;
const MAX_RESULT = 900;
const MAX_LIST_ITEMS = 6;
const MAX_LIST_ITEM = 280;

function required(name: string, value: string, problems: string[]) {
  const length = value.trim().length;
  if (!length) problems.push(`Write the ${name}.`);
  else if (length > MAX_SHORT)
    problems.push(
      `${name} is ${length} characters; keep it under ${MAX_SHORT}.`,
    );
}

function listProblems(
  name: string,
  items: readonly string[],
  problems: string[],
) {
  if (!items.length) problems.push(`State at least one ${name}.`);
  else if (items.length > MAX_LIST_ITEMS)
    problems.push(`Give at most ${MAX_LIST_ITEMS} ${name}.`);
  for (const item of items) {
    const length = item.trim().length;
    if (!length) problems.push(`${name} cannot be blank.`);
    else if (length > MAX_LIST_ITEM)
      problems.push(
        `${name} item is ${length} characters; keep it under ${MAX_LIST_ITEM}.`,
      );
  }
}

export function verificationProblems(
  input: VerificationInput,
  changed: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const key of [
    "target",
    "property",
    "harm",
    "checker",
    "command",
    "scope",
  ] as const)
    required(key, input[key], problems);

  const resultLength = input.result.trim().length;
  if (!resultLength)
    problems.push("Write the checker result or why it was not run.");
  else if (resultLength > MAX_RESULT)
    problems.push(
      `result is ${resultLength} characters; keep it under ${MAX_RESULT}.`,
    );

  if (!input.files.length)
    problems.push("List the changed files this verification covers.");
  const unknown = input.files.filter((file) => !changed.includes(file));
  if (unknown.length)
    problems.push(
      `Not changed in this pull request: ${unknown.join(", ")}. Use paths exactly as pr_overview lists them.`,
    );

  listProblems("assumption", input.assumptions, problems);
  listProblems("limit", input.limits, problems);

  const broken = input.broken_variant?.trim() ?? "";
  if (broken.length > MAX_RESULT)
    problems.push(`broken_variant must be under ${MAX_RESULT} characters.`);
  if (input.outcome === "passed" && !broken)
    problems.push(
      "A passed check needs a broken_variant that the same check rejected.",
    );
  if (
    input.outcome === "counterexample" &&
    !/counterexample|trace|violation|failed/i.test(input.result)
  )
    problems.push(
      "A counterexample result must say the trace, violation or failure the checker produced.",
    );
  if (
    input.outcome === "not_run" &&
    !/not run|unavailable|planned|cannot|could not/i.test(input.result)
  )
    problems.push(
      "A not_run result must plainly say why no checker result exists.",
    );
  if (input.fix_check) {
    if (input.outcome !== "counterexample")
      problems.push(
        "A fix_check requires a counterexample on the reviewed head.",
      );
    if (
      input.fix_check.outcome !== "passed" &&
      input.fix_check.outcome !== "failed"
    )
      problems.push("State whether the proposed fix check passed or failed.");
    for (const key of ["command", "before", "after"] as const)
      required(`fix_check ${key}`, input.fix_check[key], problems);
  }
  return problems;
}

/** Changed files with no formal-review receipt. Every one needs a disposition. */
export function uncoveredVerificationFiles(
  files: readonly { path: string }[],
  receipts: readonly VerificationReceipt[],
): string[] {
  const covered = new Set(receipts.flatMap((receipt) => receipt.files));
  return files.map((file) => file.path).filter((path) => !covered.has(path));
}

/** Converts tool input to the persisted shape after validation. */
export function receiptFrom(
  id: string,
  input: VerificationInput,
): VerificationReceipt {
  return {
    id,
    files: [...new Set(input.files)],
    target: input.target.trim(),
    property: input.property.trim(),
    harm: input.harm.trim(),
    method: input.method,
    checker: input.checker.trim(),
    command: input.command.trim(),
    outcome: input.outcome,
    result: input.result.trim(),
    scope: input.scope.trim(),
    brokenVariant: input.broken_variant?.trim() || null,
    assumptions: input.assumptions.map((item) => item.trim()),
    limits: input.limits.map((item) => item.trim()),
    ...(input.fix_check
      ? {
          fixCheck: {
            command: input.fix_check.command.trim(),
            before: input.fix_check.before.trim(),
            after: input.fix_check.after.trim(),
            outcome: input.fix_check.outcome,
          },
        }
      : {}),
  };
}
