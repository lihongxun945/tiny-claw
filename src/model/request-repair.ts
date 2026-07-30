export interface ModelRequestRepairContext {
  provider: string;
  model: string;
  status: number;
  errorBody: string;
  requestBody: Record<string, unknown>;
  appliedRepairs: ReadonlySet<string>;
}

export interface ModelRequestRepairResult {
  name: string;
  requestBody: Record<string, unknown>;
}

export interface ModelRequestRepair {
  name: string;
  repair(context: ModelRequestRepairContext): ModelRequestRepairResult | undefined;
}

const maxTokensCompatibilityRepair: ModelRequestRepair = {
  name: "max-tokens-compatibility",
  repair(context) {
    if (context.status !== 400 || context.appliedRepairs.has(this.name)) return undefined;
    if (typeof context.requestBody.max_tokens !== "number") return undefined;

    const error = context.errorBody.toLowerCase();
    const requestsReplacement = error.includes("max_tokens")
      && error.includes("max_completion_tokens")
      && (error.includes("not supported") || error.includes("unsupported"));
    if (!requestsReplacement) return undefined;

    const { max_tokens: maxTokens, ...requestBody } = context.requestBody;
    return {
      name: this.name,
      requestBody: {
        ...requestBody,
        max_completion_tokens: maxTokens,
      },
    };
  },
};

const defaultRepairs: ModelRequestRepair[] = [
  maxTokensCompatibilityRepair,
];

export function repairModelRequest(
  context: ModelRequestRepairContext,
  repairs: readonly ModelRequestRepair[] = defaultRepairs,
): ModelRequestRepairResult | undefined {
  for (const repair of repairs) {
    const result = repair.repair(context);
    if (result) return result;
  }
  return undefined;
}
