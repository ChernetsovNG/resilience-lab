/** Policy editing is introduced by T4; existing policy values remain readable and preserved. */
export const readOnlyCallPolicies = new Set(["circuitBreaker", "retryBudget", "fallback"]);
