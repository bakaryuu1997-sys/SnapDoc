import { describe, it, expect } from "vitest";
import jsQR from "jsqr";
import { decodeQrFromDataUrl } from "./qrService";

describe("qrService", () => {
  it("jsqr handles blank image without crashing", () => {
    const data = new Uint8ClampedArray(100 * 100 * 4);
    const res = jsQR(data, 100, 100);
    expect(res).toBeNull();
  });

  it("decodeQrFromDataUrl handles invalid or empty dataUrl safely", async () => {
    const res = await decodeQrFromDataUrl("");
    expect(res).toBeNull();
  });
});
