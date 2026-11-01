import type { ModelFile } from "../api/apiTypes";

type Step = NonNullable<ModelFile["blocks"][string]["scenario"]>[number];

/** Rewrites nested steps after their children; null removes a step. Source documents remain unchanged. */
export function mapScenario(steps: readonly Step[], map: (step: Step, original: Step) => Step | null): Step[] {
  return steps.flatMap(original => {
    const nested = { ...original,
      ...(original.onMiss == null ? {} : { onMiss: mapScenario(original.onMiss, map) }),
      ...(original.branches == null ? {} : { branches: original.branches.map(branch => mapScenario(branch, map)) }),
    };
    const step = map(nested, original);
    return step === null ? [] : [step];
  });
}

/** Every step, including miss handlers and parallel branches, in document order. */
export function* walkScenario(steps: readonly Step[]): Generator<Step> {
  for (const step of steps) {
    yield step;
    yield* walkScenario(step.onMiss ?? []);
    for (const branch of step.branches ?? []) yield* walkScenario(branch);
  }
}
