import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({ chromium: { launch: mocks.launch } }));

const SIGTRAP_LAUNCH_ERROR =
  "browserType.launch: Target page, context or browser has been closed\n" +
  "  - <launched> pid=407854\n  - <process did exit: exitCode=null, signal=SIGTRAP>";

const PRODUCT_HTML = `<html><head><title>Linen Dress - Shop</title>
<meta name="description" content="A linen dress.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Linen Dress","description":"A linen dress."}</script>
</head><body><h1>Linen Dress</h1></body></html>`;

let outputDir: string;

beforeEach(() => {
  outputDir = mkdtempSync(path.join(tmpdir(), "seoscrape-test-"));
  vi.stubEnv("OUTPUT_DIR", outputDir);
  vi.resetModules();
  mocks.launch.mockReset();
  mocks.launch.mockRejectedValue(new Error(SIGTRAP_LAUNCH_ERROR));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const res = new Response(PRODUCT_HTML, { status: 200, headers: { "content-type": "text/html", server: "nginx" } });
      Object.defineProperty(res, "url", { value: input.toString() });
      return res;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(outputDir, { recursive: true, force: true });
});

describe("runCheck when Chromium cannot start", () => {
  it("fails with PAGE_LOAD_FAILED by default (unchanged contract: clients keep their 502 and their own fallback)", async () => {
    const { runCheck } = await import("../src/routes/checkProduct.js");
    const { CheckError } = await import("../src/types/productCheck.js");

    const err = await runCheck("https://shop.example/products/linen-dress").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CheckError);
    expect((err as InstanceType<typeof CheckError>).code).toBe("PAGE_LOAD_FAILED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("with fetchFallback, returns the fetched page marked with a BROWSER_UNAVAILABLE warning", async () => {
    const { runCheck, BROWSER_UNAVAILABLE_WARNING } = await import("../src/routes/checkProduct.js");
    const progress = vi.fn();

    const { result } = await runCheck("https://shop.example/products/linen-dress", progress, { fetchFallback: true });

    expect(result.kind).toBe("product");
    if (result.kind !== "product") return;
    expect(result.warnings).toContain(BROWSER_UNAVAILABLE_WARNING);
    expect(result.seo.title.value).toBe("Linen Dress - Shop");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^Browser unavailable/) }));
  });
});
