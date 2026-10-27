/** Converts UI requests per second to the scenario's requests per millisecond. */
export function rpsToArrivalRate(rps: number): number {
  return rps / 1_000;
}

/** Converts the scenario's requests per millisecond to UI requests per second. */
export function arrivalRateToRps(arrivalRate: number): number {
  return arrivalRate * 1_000;
}
