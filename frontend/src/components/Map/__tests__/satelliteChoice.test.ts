import { describe, expect, it } from "vitest";
import {
  buildImageryLoop,
  collapseRepeatFrames,
  dissolveOpacity,
  formatGibsTime,
  formatStamp,
  gibsProbeUrl,
  gibsTilesAt,
  glmCovers,
  isRealEarthNotice,
  loopHasMotion,
  pickStamp,
  pingPongOrder,
  productTimes,
  realEarthProviderModule,
  sampleNoticePixels,
  satelliteFor,
  tileTemplate,
} from "../satelliteChoice";

describe("satelliteFor", () => {
  it("picks the nearest full disk", () => {
    expect(satelliteFor(-75).id).toBe("goes-east");
    expect(satelliteFor(-120).id).toBe("goes-west");
    expect(satelliteFor(155).id).toBe("himawari");
    expect(satelliteFor(10).id).toBe("meteosat");
    // 170°W is closer to GOES-West (137°W) than to Himawari (141°E).
    expect(satelliteFor(-170).id).toBe("goes-west");
  });

  it("loads GOES true color from NASA GIBS in y-then-x order", () => {
    const east = satelliteFor(-75);
    expect(east.host).toBe("gibs");
    expect(east.maxzoom).toBe(7);
    expect(east.tiles).toContain("GOES-East_ABI_GeoColor");
    expect(east.tiles).toContain("{z}/{y}/{x}");
    expect(east.tiles).not.toContain("{z}/{x}/{y}");
    expect(satelliteFor(-120).tiles).toContain("GOES-West_ABI_GeoColor");
  });

  it("loads Himawari as infrared, not a true-color tile", () => {
    const bird = satelliteFor(140);
    expect(bird.host).toBe("gibs");
    expect(bird.maxzoom).toBe(6);
    expect(bird.tiles).toContain("Himawari_AHI_Band13_Clean_Infrared");
    expect(bird.label).toMatch(/infrared/i);
    expect(bird.note).toMatch(/Not true color/);
  });

  it("keeps Meteosat on RealEarth infrared", () => {
    const bird = satelliteFor(8);
    expect(bird.host).toBe("realearth");
    expect(bird.product).toBe("Met11-SEVIRI-FD-BAND09-enh");
    expect(bird.tiles).toBeNull();
    expect(bird.note).toMatch(/infrared/i);
    expect(bird.note).toMatch(/Not true color/);
  });
});

describe("glmCovers", () => {
  it("covers the Atlantic and not Japan or Europe", () => {
    expect(glmCovers(25, -80)).toBe(true);
    expect(glmCovers(26, 155)).toBe(false);
    expect(glmCovers(48, 10)).toBe(false);
    expect(glmCovers(70, -70)).toBe(false);
  });
});

describe("tile urls", () => {
  it("pins a RealEarth stamp into the XYZ path", () => {
    expect(tileTemplate("G19-ABI-FD-true-color", "20261008.005021")).toBe(
      "https://realearth.ssec.wisc.edu/tiles/G19-ABI-FD-true-color/20261008/005021/{z}/{x}/{y}.png",
    );
    expect(tileTemplate("glmgroupdensity", null)).toBe(
      "https://realearth.ssec.wisc.edu/tiles/glmgroupdensity/{z}/{x}/{y}.png",
    );
    expect(tileTemplate("glmgroupdensity", "nope")).toBe(
      "https://realearth.ssec.wisc.edu/tiles/glmgroupdensity/{z}/{x}/{y}.png",
    );
  });

  it("formats the stamp for the panel", () => {
    expect(formatStamp("20261008.005021")).toBe("2026-10-08 00:50 UTC");
    expect(formatStamp(null)).toBeNull();
  });

  it("reads a GIBS scan time and probes z/y/x zero", () => {
    expect(formatGibsTime("2026-10-08T01:30:00Z")).toBe("2026-10-08 01:30 UTC");
    expect(formatGibsTime(null)).toBeNull();
    expect(gibsProbeUrl("https://example.test/L/{z}/{y}/{x}.jpg")).toBe(
      "https://example.test/L/0/0/0.jpg",
    );
  });
});

describe("RealEarth size-limit notice", () => {
  it("drops the black placard and white text on an empty lightning tile", () => {
    // Fractions measured on a RealEarth "Size limit exceeded" tile.
    expect(isRealEarthNotice({ pixels: 10000, transparent: 0, black: 9840, white: 160 })).toBe(true);
    // Same text on a transparent GLM tile.
    expect(isRealEarthNotice({ pixels: 10000, transparent: 9630, black: 130, white: 160 })).toBe(true);
    // Clean flashes: yellow only, no white text.
    expect(isRealEarthNotice({ pixels: 10000, transparent: 9950, black: 0, white: 0 })).toBe(false);
    // GeoColor is dark in places and has white cloud. Not the notice.
    expect(isRealEarthNotice({ pixels: 10000, transparent: 0, black: 3310, white: 430 })).toBe(false);
    expect(isRealEarthNotice({ pixels: 0, transparent: 0, black: 0, white: 0 })).toBe(false);
  });

  it("classifies sampled pixels the same way", () => {
    const placard = new Uint8ClampedArray(100 * 4);
    for (let i = 0; i < 100; i += 1) {
      const o = i * 4;
      placard[o] = 0;
      placard[o + 1] = 0;
      placard[o + 2] = 0;
      placard[o + 3] = 255;
    }
    placard[0] = 240;
    placard[1] = 240;
    placard[2] = 240;
    expect(isRealEarthNotice(sampleNoticePixels(placard))).toBe(true);

    const flashes = new Uint8ClampedArray(100 * 4);
    flashes[0] = 255;
    flashes[1] = 220;
    flashes[2] = 0;
    flashes[3] = 255;
    expect(isRealEarthNotice(sampleNoticePixels(flashes))).toBe(false);
  });

  it("ships the notice check inside the tile provider module", () => {
    const source = realEarthProviderModule();
    expect(source).toContain("export default class RealEarthTileProvider");
    expect(source).toContain("return { data: null }");
    expect(source).toContain("function isRealEarthNotice");
  });
});

describe("imagery loop", () => {
  it("puts a GIBS scan time in the template and keeps y-then-x", () => {
    const tiles = satelliteFor(-75).tiles ?? "";
    const stamped = gibsTilesAt(tiles, "2026-10-08T00:30:00Z");
    expect(stamped).toContain("GOES-East_ABI_GeoColor/default/2026-10-08T00:30:00Z/");
    expect(stamped).not.toContain("/default/default/");
    expect(stamped).toContain("{z}/{y}/{x}.jpg");
    expect(stamped).not.toContain("{z}/{x}/{y}");
    expect(stamped).not.toContain("?r=");
  });

  it("steps a GIBS hour every 10 minutes through the latest scan", () => {
    const frames = buildImageryLoop({
      mode: "gibs",
      gibsLatestIso: "2026-10-08T01:30:00Z",
      satStamps: [],
      glmStamps: [],
    });
    expect(frames).toHaveLength(7);
    expect(frames[0]?.gibsIso).toBe("2026-10-08T00:30:00Z");
    expect(frames[6]?.gibsIso).toBe("2026-10-08T01:30:00Z");
    const ms = frames.map((f) => Date.parse(f.gibsIso ?? ""));
    for (let i = 1; i < ms.length; i += 1) {
      expect(ms[i] - ms[i - 1]).toBe(10 * 60 * 1000);
    }
    expect(loopHasMotion(frames)).toBe(true);
  });

  it("subsamples one-minute lightning onto the 10 minute clock", () => {
    const stamps: string[] = [];
    for (let minute = 0; minute <= 60; minute += 1) {
      const hh = 1 + Math.floor(minute / 60);
      const mm = minute % 60;
      const stamp = `20261008.${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}00`;
      if (stamp !== "20261008.012200") stamps.push(stamp);
    }
    const frames = buildImageryLoop({
      mode: "lightning-only",
      gibsLatestIso: null,
      satStamps: [],
      glmStamps: stamps,
    });
    expect(frames).toHaveLength(7);
    expect(frames.length).toBeLessThan(20);
    expect(frames[frames.length - 1]?.glmStamp).toBe("20261008.020000");
    expect(frames.every((f) => stamps.includes(f.glmStamp ?? ""))).toBe(true);
    expect(new Set(frames.map((f) => f.glmStamp)).size).toBeGreaterThanOrEqual(6);
    expect(loopHasMotion(frames)).toBe(true);
  });

  it("holds hourly Meteosat scans and does not invent times", () => {
    const stamps = ["20261008.010000", "20261008.020000"];
    const frames = buildImageryLoop({
      mode: "realearth",
      gibsLatestIso: null,
      satStamps: stamps,
      glmStamps: [],
    });
    expect(frames).toHaveLength(7);
    expect(frames.every((f) => stamps.includes(f.satStamp ?? ""))).toBe(true);
    expect(new Set(frames.map((f) => f.satStamp))).toEqual(new Set(stamps));
    expect(loopHasMotion(frames)).toBe(true);
    const one = buildImageryLoop({
      mode: "realearth",
      gibsLatestIso: null,
      satStamps: ["20261008.020000"],
      glmStamps: [],
    });
    expect(loopHasMotion(one)).toBe(false);
  });

  it("dissolves forward and back without cutting to the oldest scan", () => {
    const frames = buildImageryLoop({
      mode: "gibs",
      gibsLatestIso: "2026-10-08T01:30:00Z",
      satStamps: [],
      glmStamps: [],
    });
    expect(collapseRepeatFrames(frames)).toHaveLength(7);
    const order = pingPongOrder(7);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]);
    expect(order[0]).not.toBe(order[order.length - 1]);
    expect(pingPongOrder(2)).toEqual([0, 1]);
    expect(pingPongOrder(1)).toEqual([0]);
    const hourly = collapseRepeatFrames(buildImageryLoop({
      mode: "realearth",
      gibsLatestIso: null,
      satStamps: ["20261008.010000", "20261008.020000"],
      glmStamps: [],
    }));
    expect(hourly.map((frame) => frame.satStamp)).toEqual([
      "20261008.010000",
      "20261008.020000",
    ]);
    expect(dissolveOpacity(0, 1000)).toBe(0);
    expect(dissolveOpacity(500, 1000)).toBe(0.5);
    expect(dissolveOpacity(1000, 1000)).toBe(1);
  });

  it("reads product times and does not pick a future stamp", () => {
    expect(productTimes([
      { times: ["20261008.013900", "nope", 12, "20261008.014000"] },
    ])).toEqual(["20261008.013900", "20261008.014000"]);
    expect(productTimes({})).toEqual([]);
    expect(pickStamp(
      ["20261008.013000", "20261008.014000", "20261008.015000"],
      Date.parse("2026-10-08T01:40:00Z"),
    )).toBe("20261008.014000");
  });
});
