import { describe, it, expect } from "vitest";
import { shouldBlockResource } from "../src/services/pageLoader.js";

const ON = { blockAssets: true, blockStylesheets: false };
const AGGRESSIVE = { blockAssets: true, blockStylesheets: true };
const OFF = { blockAssets: false, blockStylesheets: false };

describe("shouldBlockResource", () => {
  it("blocks bandwidth-heavy media types when enabled", () => {
    expect(shouldBlockResource("image", ON)).toBe(true);
    expect(shouldBlockResource("media", ON)).toBe(true);
    expect(shouldBlockResource("font", ON)).toBe(true);
  });

  it("never blocks the resource types that carry data / drive lazy grids", () => {
    for (const type of ["document", "script", "xhr", "fetch", "websocket"]) {
      expect(shouldBlockResource(type, ON)).toBe(false);
      expect(shouldBlockResource(type, AGGRESSIVE)).toBe(false);
    }
  });

  it("keeps stylesheets by default but drops them in aggressive mode", () => {
    expect(shouldBlockResource("stylesheet", ON)).toBe(false);
    expect(shouldBlockResource("stylesheet", AGGRESSIVE)).toBe(true);
  });

  it("blocks nothing when asset blocking is disabled", () => {
    for (const type of ["image", "media", "font", "stylesheet"]) {
      expect(shouldBlockResource(type, OFF)).toBe(false);
    }
  });
});
