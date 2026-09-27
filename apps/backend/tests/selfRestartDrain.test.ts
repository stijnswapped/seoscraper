import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ acceptingWork: true }));

vi.mock("../src/services/pageLoader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/pageLoader.js")>()),
  isAcceptingWork: () => mocks.acceptingWork,
}));

import { buildServer } from "../src/server.js";
import { hasPendingJobs, markJobDelivered, startJob } from "../src/services/checkJobs.js";
import type { ApiResult } from "../src/routes/checkProduct.js";

afterEach(() => {
  mocks.acceptingWork = true;
});

describe("hasPendingJobs (what a self-restart waits for)", () => {
  it("covers running jobs and finished results nobody has collected yet, within the grace period", async () => {
    let finish!: () => void;
    const record = startJob({
      jobId: `job_test_${Math.random()}`,
      ownerUserId: null,
      responseMode: undefined,
      run: () => new Promise<ApiResult>((resolve) => (finish = () => resolve({} as ApiResult))),
      onSettle: () => {},
    });
    expect(hasPendingJobs(60_000)).toBe(true);

    finish();
    await record.promise;
    const finishedAt = record.finishedAt!;
    expect(hasPendingJobs(60_000, finishedAt + 30_000)).toBe(true);
    expect(hasPendingJobs(60_000, finishedAt + 61_000)).toBe(false);

    markJobDelivered(record);
    expect(hasPendingJobs(60_000, finishedAt + 1_000)).toBe(false);
  });
});

describe("scrape requests while the service drains for a self-restart", () => {
  it("turns new check-product and listings-track requests away with a retryable 503, but still answers polls", async () => {
    const app = await buildServer();
    try {
      mocks.acceptingWork = false;

      for (const url of ["/api/check-product", "/api/listings/track"]) {
        const res = await app.inject({ method: "POST", url, payload: { url: "https://shop.example/products/x" } });
        expect(res.statusCode).toBe(503);
        expect(res.headers["retry-after"]).toBe("60");
        expect(res.json()).toMatchObject({ success: false, error: { code: "SERVICE_RESTARTING" } });
      }

      const poll = await app.inject({ method: "GET", url: "/api/check-product/job_unknown" });
      expect(poll.statusCode).not.toBe(503);
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);

      mocks.acceptingWork = true;
      const accepted = await app.inject({ method: "POST", url: "/api/check-product", payload: {} });
      expect(accepted.statusCode).not.toBe(503);
    } finally {
      await app.close();
    }
  });
});
