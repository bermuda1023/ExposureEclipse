/**
 * Windy.com-style animated wind particles.
 *
 * A Mapbox GL custom-layer (WebGL) that reads the currently-active wind
 * grid (observed / GFS / ECMWF) and animates thousands of drifting
 * particles along the u/v vector field. Trails are produced by keeping the
 * previous frame's framebuffer around and drawing it back with a slight
 * fade before overlaying the freshly-advected points.
 *
 * The heavy lifting is in ``WindParticleShaders.ts``. This file wires it
 * into React + Mapbox and manages GL state (textures, framebuffers, buffers).
 *
 * Grid switch, mode switch, storm switch → recompute the wind-field
 * texture from the new cell set and swap it in. Particles keep flowing;
 * they just start seeing the new field.
 */

import type { Map as MbMap } from "mapbox-gl";
import { useEffect } from "react";
import { useLiveStormStore } from "../../state/liveStorm";
import {
  UPDATE_FRAG,
  DRAW_VERT,
  DRAW_FRAG,
  QUAD_VERT,
  SCREEN_FRAG,
} from "./WindParticleShaders";

const LAYER_ID = "wind-particles";

// Tuning knobs, calibrated against a side-by-side Windy.com comparison.
// The visual goal is soft, elongated white streaks flowing along the
// vector field — NOT tiny fast dots. Long trails + slow motion + big
// particles + high density is what gives that "paint being brushed
// along the wind" look. Underlying heatmap conveys speed; particles
// convey direction and motion.
const PARTICLE_RES = 96;                 // → 96×96 = 9216 particles
const FADE_OPACITY = 0.94;               // slow decay = long visible trails
// At 50 kt with the shader's built-in 0.0001 factor, a SPEED_FACTOR of 0.6
// gives ~10-15 s to traverse a Bertha-size bbox — matches Windy's leisurely
// flow. Was 3.5 which crossed the storm in ~1 s (blur, not streaks).
const SPEED_FACTOR = 0.6;
const DROP_RATE = 0.003;                 // baseline particle respawn rate
const DROP_RATE_BUMP = 0.01;             // extra respawn in low-wind cells
const POINT_SIZE = 2.5;                  // pixel size for each particle
const PARTICLE_ALPHA = 0.55;             // per-particle base alpha; trails
                                         // then fade below this via FADE_OPACITY

// Whitish palette with just a hint of colour for high winds — mirrors
// Windy.com's aesthetic where the particles read as motion and the
// underlying heatmap carries the speed information. Dark saturated
// colours from earlier iterations turned the particle layer into an
// opaque black mass over the map.
const RAMP_COLORS: Record<number, string> = {
  0.00: "rgb(255,255,255)",
  0.20: "rgb(255,255,240)",
  0.40: "rgb(255,250,220)",
  0.60: "rgb(255,240,200)",
  0.80: "rgb(255,230,210)",
  1.00: "rgb(255,220,220)",
};

interface Props {
  map: MbMap | null;
}

interface Cell {
  lat: number;
  lon: number;
  windKt: number;
  windDirDeg: number | null;
}

/** Build the wind-field lookup texture from a cell grid.
 *  Output RGBA where R/G are u/v components mapped to [0, 255], B/A unused. */
function buildWindField(
  cells: Cell[],
  bbox: [number, number, number, number],
): {
  data: Uint8Array;
  width: number;
  height: number;
  uMin: number; uMax: number; vMin: number; vMax: number;
} | null {
  const [west, south, east, north] = bbox;
  const step = 0.25;
  const width = Math.max(2, Math.round((east - west) / step) + 1);
  const height = Math.max(2, Math.round((north - south) / step) + 1);

  const uArr = new Float32Array(width * height);
  const vArr = new Float32Array(width * height);
  const has = new Uint8Array(width * height);
  let uMin = Infinity, uMax = -Infinity;
  let vMin = Infinity, vMax = -Infinity;

  for (const c of cells) {
    if (c.windDirDeg == null) continue;
    const i = Math.round((c.lon - west) / step);
    const j = Math.round((c.lat - south) / step);
    if (i < 0 || i >= width || j < 0 || j >= height) continue;

    // Meteorological "wind from" convention → advection components:
    const rad = (c.windDirDeg * Math.PI) / 180;
    const u = -c.windKt * Math.sin(rad);
    const v = -c.windKt * Math.cos(rad);

    const idx = j * width + i;
    uArr[idx] = u;
    vArr[idx] = v;
    has[idx] = 1;
    uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
  }

  // Symmetric bounds so 0 = neutral advection at the mid-value 127.
  const magU = Math.max(Math.abs(uMin), Math.abs(uMax), 1);
  const magV = Math.max(Math.abs(vMin), Math.abs(vMax), 1);
  const finalUMin = -magU, finalUMax = magU;
  const finalVMin = -magV, finalVMax = magV;

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    // Missing cells encode as the neutral mid-value so particles drifting
    // over them just stop rather than being flung.
    const u = has[i] ? uArr[i] : 0;
    const v = has[i] ? vArr[i] : 0;
    data[i * 4] = Math.round(
      ((u - finalUMin) / (finalUMax - finalUMin)) * 255,
    );
    data[i * 4 + 1] = Math.round(
      ((v - finalVMin) / (finalVMax - finalVMin)) * 255,
    );
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return {
    data, width, height,
    uMin: finalUMin, uMax: finalUMax,
    vMin: finalVMin, vMax: finalVMax,
  };
}

function buildColorRampTexture(gl: WebGLRenderingContext): WebGLTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  for (const [stop, color] of Object.entries(RAMP_COLORS)) {
    grad.addColorStop(parseFloat(stop), color);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 1);
  // We only need one row scaled up as a 16x16 for the shader's fract/floor
  // sampling trick, so expand horizontally.
  const scaled = document.createElement("canvas");
  scaled.width = 16; scaled.height = 16;
  const sctx = scaled.getContext("2d")!;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = y * 16 + x;
      const t = i / 255;
      // Sample the gradient at t.
      const px = ctx.getImageData(Math.min(255, Math.floor(t * 256)), 0, 1, 1).data;
      sctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`;
      sctx.fillRect(x, y, 1, 1);
    }
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scaled);
  return tex;
}

function compileShader(
  gl: WebGLRenderingContext, type: number, source: string,
): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(s) ?? "unknown";
    gl.deleteShader(s);
    throw new Error(`shader compile: ${err}`);
  }
  return s;
}

function linkProgram(
  gl: WebGLRenderingContext, vert: string, frag: string,
): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const err = gl.getProgramInfoLog(p) ?? "unknown";
    gl.deleteProgram(p);
    throw new Error(`program link: ${err}`);
  }
  return p;
}

function createTexture(
  gl: WebGLRenderingContext,
  width: number, height: number,
  data: Uint8Array | null,
  filter: number = gl.NEAREST,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, data,
  );
  return tex;
}

function makeParticleStateTexture(
  gl: WebGLRenderingContext, res: number,
): WebGLTexture {
  const n = res * res;
  const state = new Uint8Array(n * 4);
  for (let i = 0; i < n * 4; i++) state[i] = Math.floor(Math.random() * 256);
  return createTexture(gl, res, res, state, gl.NEAREST);
}

interface LayerState {
  gl: WebGLRenderingContext;
  updateProgram: WebGLProgram;
  drawProgram: WebGLProgram;
  screenProgram: WebGLProgram;
  quadBuffer: WebGLBuffer;
  particleIndexBuffer: WebGLBuffer;
  particleStateA: WebGLTexture;
  particleStateB: WebGLTexture;
  screenTextureA: WebGLTexture;
  screenTextureB: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  colorRampTexture: WebGLTexture;

  windTexture: WebGLTexture | null;
  windRes: [number, number];
  windMin: [number, number];
  windMax: [number, number];
  bbox: [number, number, number, number];
  particleCount: number;
  particleRes: number;

  screenWidth: number;
  screenHeight: number;
}

/** Read the currently-relevant cell list (obs / gfs / ecmwf) out of the
 *  Zustand store, in a shape the wind-field builder can consume. Returns
 *  null when the active grid has no cells (renderer should hide). */
function materializeModelCells(
  grid: import("../../api/live").WindModelGrid | null,
  frameIdx: number,
): Cell[] {
  if (!grid || grid.frames.length === 0) return [];
  const clamped = Math.min(Math.max(0, frameIdx), grid.frames.length - 1);
  const frame = grid.frames[clamped];
  if (!frame) return [];
  return grid.cells.map((c, i) => ({
    lat: c.lat,
    lon: c.lon,
    windKt: frame.windKt[i] ?? 0,
    windDirDeg: frame.windDirDeg[i] ?? null,
  }));
}

function selectActiveCells(): {
  cells: Cell[];
  bbox: [number, number, number, number] | null;
} | null {
  const s = useLiveStormStore.getState();
  if (!s.showWindMap || !s.showWindParticles) return null;
  const mode = s.windMapMode;
  const bbox = s.data?.bbox as [number, number, number, number] | undefined;
  if (!bbox) return null;
  if (mode === "observed") {
    const cells = (s.data?.windMap ?? []).map((c) => ({
      lat: c.lat, lon: c.lon, windKt: c.windKt, windDirDeg: c.windDirDeg,
    }));
    return { cells, bbox };
  }
  if (mode === "gfs") {
    return {
      cells: materializeModelCells(s.gfsGrid, s.windMapFrameIndex),
      bbox,
    };
  }
  if (mode === "ecmwf") {
    return {
      cells: materializeModelCells(s.ecmwfGrid, s.windMapFrameIndex),
      bbox,
    };
  }
  // Diff modes: skip particles — the diverging color palette is what
  // conveys the story there, and animated particles on a diff field
  // would be confusing.
  return { cells: [], bbox };
}

export function WindParticleLayer({ map }: Props) {
  const showWindMap = useLiveStormStore((s) => s.showWindMap);
  const showWindParticles = useLiveStormStore((s) => s.showWindParticles);
  const data = useLiveStormStore((s) => s.data);
  const mode = useLiveStormStore((s) => s.windMapMode);
  const gfsGrid = useLiveStormStore((s) => s.gfsGrid);
  const ecmwfGrid = useLiveStormStore((s) => s.ecmwfGrid);
  const frameIndex = useLiveStormStore((s) => s.windMapFrameIndex);

  useEffect(() => {
    if (!map) return;
    if (!showWindMap || !showWindParticles) {
      // Ensure layer is removed if it exists.
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      } catch { /* map torn down */ }
      return;
    }

    let state: LayerState | null = null;
    let cancelled = false;

    // Skip diff modes — particles only make sense in observed / gfs / ecmwf.
    if (mode.startsWith("diff-")) {
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      } catch { /* */ }
      return;
    }

    const active = selectActiveCells();
    if (!active || !active.bbox || active.cells.length === 0) {
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      } catch { /* */ }
      return;
    }

    const layer: mapboxgl.CustomLayerInterface = {
      id: LAYER_ID,
      type: "custom",
      renderingMode: "2d",

      onAdd(_mapArg, gl) {
        try {
          const updateProgram = linkProgram(gl, QUAD_VERT, UPDATE_FRAG);
          const drawProgram = linkProgram(gl, DRAW_VERT, DRAW_FRAG);
          const screenProgram = linkProgram(gl, QUAD_VERT, SCREEN_FRAG);

          const quadBuffer = gl.createBuffer()!;
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
          gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
            gl.STATIC_DRAW,
          );

          const particleCount = PARTICLE_RES * PARTICLE_RES;
          const indices = new Float32Array(particleCount);
          for (let i = 0; i < particleCount; i++) indices[i] = i;
          const particleIndexBuffer = gl.createBuffer()!;
          gl.bindBuffer(gl.ARRAY_BUFFER, particleIndexBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);

          const wf = buildWindField(active.cells, active.bbox!);
          if (!wf) throw new Error("empty wind field");
          const windTexture = createTexture(
            gl, wf.width, wf.height, wf.data, gl.LINEAR,
          );

          const particleStateA = makeParticleStateTexture(gl, PARTICLE_RES);
          const particleStateB = makeParticleStateTexture(gl, PARTICLE_RES);

          const canvas = gl.canvas as HTMLCanvasElement;
          const screenTextureA = createTexture(
            gl, canvas.width, canvas.height, null, gl.NEAREST,
          );
          const screenTextureB = createTexture(
            gl, canvas.width, canvas.height, null, gl.NEAREST,
          );

          const framebuffer = gl.createFramebuffer()!;
          const colorRampTexture = buildColorRampTexture(gl);

          // Clear screen textures to transparent — createTexture(null)
          // leaves undefined content on most drivers, which shows up as
          // random garbage bleeding through the trails.
          clearTexture(gl, framebuffer, screenTextureA);
          clearTexture(gl, framebuffer, screenTextureB);

          state = {
            gl, updateProgram, drawProgram, screenProgram,
            quadBuffer, particleIndexBuffer,
            particleStateA, particleStateB,
            screenTextureA, screenTextureB,
            framebuffer, colorRampTexture,
            windTexture,
            windRes: [wf.width, wf.height],
            windMin: [wf.uMin, wf.vMin],
            windMax: [wf.uMax, wf.vMax],
            bbox: active.bbox!,
            particleCount,
            particleRes: PARTICLE_RES,
            screenWidth: canvas.width,
            screenHeight: canvas.height,
          };
        } catch (err) {
          // Layer init failed (WebGL context issue, shader compile error);
          // silently deactivate rather than blow up the map.
          state = null;
          // eslint-disable-next-line no-console
          console.warn("[wind-particles] init failed:", err);
        }
      },

      render(gl, matrix) {
        if (!state || cancelled) return;
        const s = state;

        // Reallocate screen textures if the canvas size changed. Also
        // clear the new ones to transparent so the fade pass has a clean
        // starting state (createTexture with null leaves memory undefined
        // on most drivers).
        const canvas = gl.canvas as HTMLCanvasElement;
        if (canvas.width !== s.screenWidth || canvas.height !== s.screenHeight) {
          gl.deleteTexture(s.screenTextureA);
          gl.deleteTexture(s.screenTextureB);
          s.screenTextureA = createTexture(
            gl, canvas.width, canvas.height, null, gl.NEAREST,
          );
          s.screenTextureB = createTexture(
            gl, canvas.width, canvas.height, null, gl.NEAREST,
          );
          clearTexture(gl, s.framebuffer, s.screenTextureA);
          clearTexture(gl, s.framebuffer, s.screenTextureB);
          s.screenWidth = canvas.width;
          s.screenHeight = canvas.height;
        }

        // Mapbox leaves BLEND, DEPTH, STENCIL, etc. in unspecified states
        // when it hands off to a custom layer. Without explicit BLEND
        // control the fade pass ends up mixing the old screen with the
        // faded screen instead of *overwriting* it — trails then never
        // decay and the whole overlay turns opaque within seconds. Reset
        // GL state explicitly at the top of every frame.
        gl.disable(gl.BLEND);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);

        // ─── Pass 1: draw the previous screen texture into the current
        //     screen texture, faded by u_opacity — this gives us trails.
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D, s.screenTextureA, 0,
        );
        gl.viewport(0, 0, canvas.width, canvas.height);

        drawScreenPass(gl, s, s.screenTextureB, FADE_OPACITY);

        // ─── Pass 2: draw fresh particles as points on top.
        drawParticles(gl, s, matrix);

        // ─── Pass 3: composite the just-drawn frame back onto the map.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        drawScreenPass(gl, s, s.screenTextureA, 1.0);
        gl.disable(gl.BLEND);

        // ─── Pass 4: update particle positions (writes to particleStateB).
        updateParticles(gl, s);

        // Swap ping-pong textures for next frame.
        const tmpParticles = s.particleStateA;
        s.particleStateA = s.particleStateB;
        s.particleStateB = tmpParticles;
        const tmpScreen = s.screenTextureA;
        s.screenTextureA = s.screenTextureB;
        s.screenTextureB = tmpScreen;

        // Ask Mapbox for another frame — Mapbox only re-renders when the
        // map view changes, so we have to nudge it to keep animating.
        map.triggerRepaint();
      },

      onRemove(_mapArg, gl) {
        if (!state) return;
        gl.deleteProgram(state.updateProgram);
        gl.deleteProgram(state.drawProgram);
        gl.deleteProgram(state.screenProgram);
        gl.deleteBuffer(state.quadBuffer);
        gl.deleteBuffer(state.particleIndexBuffer);
        gl.deleteTexture(state.particleStateA);
        gl.deleteTexture(state.particleStateB);
        gl.deleteTexture(state.screenTextureA);
        gl.deleteTexture(state.screenTextureB);
        if (state.windTexture) gl.deleteTexture(state.windTexture);
        gl.deleteTexture(state.colorRampTexture);
        gl.deleteFramebuffer(state.framebuffer);
        state = null;
      },
    };

    const attach = () => {
      if (cancelled) return;
      if (!map.getLayer(LAYER_ID)) {
        try {
          map.addLayer(layer);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[wind-particles] addLayer failed:", err);
        }
      }
    };
    if (map.isStyleLoaded()) attach();
    else map.once("idle", attach);

    return () => {
      cancelled = true;
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      } catch { /* torn down */ }
    };
  }, [map, showWindMap, showWindParticles, data, mode, gfsGrid, ecmwfGrid, frameIndex]);

  return null;
}

// ─────────────────────────── GL passes ───────────────────────────

function drawScreenPass(
  gl: WebGLRenderingContext, s: LayerState,
  sourceTexture: WebGLTexture, opacity: number,
) {
  gl.useProgram(s.screenProgram);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
  gl.uniform1i(gl.getUniformLocation(s.screenProgram, "u_screen"), 2);
  gl.uniform1f(gl.getUniformLocation(s.screenProgram, "u_opacity"), opacity);

  bindAttribute(gl, s.quadBuffer, s.screenProgram, "a_pos", 2);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function clearTexture(
  gl: WebGLRenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture,
) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0,
  );
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function drawParticles(
  gl: WebGLRenderingContext, s: LayerState, matrix: number[],
) {
  gl.useProgram(s.drawProgram);
  bindAttribute(gl, s.particleIndexBuffer, s.drawProgram, "a_index", 1);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.colorRampTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.windTexture!);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, s.particleStateA);

  gl.uniform1i(gl.getUniformLocation(s.drawProgram, "u_color_ramp"), 0);
  gl.uniform1i(gl.getUniformLocation(s.drawProgram, "u_wind"), 1);
  gl.uniform1i(gl.getUniformLocation(s.drawProgram, "u_particles"), 2);
  gl.uniform1f(
    gl.getUniformLocation(s.drawProgram, "u_particles_res"), s.particleRes,
  );
  gl.uniform2f(
    gl.getUniformLocation(s.drawProgram, "u_wind_min"),
    s.windMin[0], s.windMin[1],
  );
  gl.uniform2f(
    gl.getUniformLocation(s.drawProgram, "u_wind_max"),
    s.windMax[0], s.windMax[1],
  );
  gl.uniform4f(
    gl.getUniformLocation(s.drawProgram, "u_bbox"),
    s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3],
  );
  gl.uniformMatrix4fv(
    gl.getUniformLocation(s.drawProgram, "u_matrix"), false, matrix,
  );
  gl.uniform1f(
    gl.getUniformLocation(s.drawProgram, "u_point_size"), POINT_SIZE,
  );
  gl.uniform1f(
    gl.getUniformLocation(s.drawProgram, "u_particle_alpha"), PARTICLE_ALPHA,
  );

  gl.drawArrays(gl.POINTS, 0, s.particleCount);
}

function updateParticles(gl: WebGLRenderingContext, s: LayerState) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D, s.particleStateB, 0,
  );
  gl.viewport(0, 0, s.particleRes, s.particleRes);
  gl.useProgram(s.updateProgram);
  bindAttribute(gl, s.quadBuffer, s.updateProgram, "a_pos", 2);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.windTexture!);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.particleStateA);

  gl.uniform1i(gl.getUniformLocation(s.updateProgram, "u_wind"), 0);
  gl.uniform1i(gl.getUniformLocation(s.updateProgram, "u_particles"), 1);
  gl.uniform1f(
    gl.getUniformLocation(s.updateProgram, "u_rand_seed"), Math.random(),
  );
  gl.uniform2f(
    gl.getUniformLocation(s.updateProgram, "u_wind_res"),
    s.windRes[0], s.windRes[1],
  );
  gl.uniform2f(
    gl.getUniformLocation(s.updateProgram, "u_wind_min"),
    s.windMin[0], s.windMin[1],
  );
  gl.uniform2f(
    gl.getUniformLocation(s.updateProgram, "u_wind_max"),
    s.windMax[0], s.windMax[1],
  );
  gl.uniform1f(
    gl.getUniformLocation(s.updateProgram, "u_speed_factor"), SPEED_FACTOR,
  );
  gl.uniform1f(
    gl.getUniformLocation(s.updateProgram, "u_drop_rate"), DROP_RATE,
  );
  gl.uniform1f(
    gl.getUniformLocation(s.updateProgram, "u_drop_rate_bump"), DROP_RATE_BUMP,
  );

  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function bindAttribute(
  gl: WebGLRenderingContext, buffer: WebGLBuffer, program: WebGLProgram,
  name: string, size: number,
) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const loc = gl.getAttribLocation(program, name);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}
