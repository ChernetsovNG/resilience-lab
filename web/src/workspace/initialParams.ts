import type { ParamDescriptor } from "../api/apiTypes";

/** Explicit values for a newly created element; never used when reading an existing document. */
export function initialParams(descriptors: readonly ParamDescriptor[]): Record<string, unknown> {
  return Object.fromEntries(descriptors.flatMap(descriptor => {
    const value = descriptor.initial ?? descriptor.default;
    return value == null ? [] : [[descriptor.name, structuredClone(value)]];
  }));
}
