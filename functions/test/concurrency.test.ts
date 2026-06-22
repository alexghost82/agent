/**
 * Unit tests — bounded-concurrency map (src/concurrency.ts).
 * Pure logic, no I/O: verifies result ordering, the in-flight cap, edge cases
 * (empty input, limit larger than the list, non-positive limit), and error
 * propagation. Runs in the default (no-emulator) suite.
 */
import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../src/concurrency";

describe("mapWithConcurrency", () => {
  it("returns results aligned to input order even when workers finish out of order", async () => {
    const items = [30, 10, 20, 0, 40];
    const out = await mapWithConcurrency(items, 2, async (n, i) => {
      // Larger values resolve later, so completion order != input order.
      await new Promise((r) => setTimeout(r, n));
      return `${i}:${n}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20", "3:0", "4:40"]);
  });

  it("passes the correct index to the worker", async () => {
    const seen: number[] = [];
    await mapWithConcurrency(["a", "b", "c"], 5, async (_item, index) => {
      seen.push(index);
      return index;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("never exceeds the requested concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_v, i) => i);
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("returns an empty array for empty input without invoking the worker", async () => {
    let called = false;
    const out = await mapWithConcurrency([], 4, async () => {
      called = true;
      return 1;
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("caps the worker count at the number of items when limit exceeds length", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2], 100, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("treats a non-positive limit as at least one worker", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1);
    expect(out).toEqual([2, 3, 4]);
  });

  it("propagates a worker error and rejects the whole run", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow(/boom/);
  });
});
