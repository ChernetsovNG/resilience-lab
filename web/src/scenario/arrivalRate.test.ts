import { describe, expect, it } from "vitest";
import { arrivalRateToRps, rpsToArrivalRate } from "./arrivalRate";

const rates = [
  [0, 0],
  [100, 0.1],
  [125.5, 0.1255],
  [0.125, 0.000125],
] as const;

describe("arrival-rate units", () => {
  it.each(rates)("converts %s RPS to %s requests per millisecond", (rps, arrivalRate) => {
    expect(rpsToArrivalRate(rps)).toBe(arrivalRate);
  });

  it.each(rates)("displays %s RPS for stored rate %s", (rps, arrivalRate) => {
    expect(arrivalRateToRps(arrivalRate)).toBe(rps);
  });
});
