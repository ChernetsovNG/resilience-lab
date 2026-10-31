/** Policy editing is introduced by T4; existing policy values remain readable and preserved. */
export const readOnlyPolicies = new Set(["circuitBreaker", "retryBudget", "fallback", "rateLimit", "healthCheck"]);
