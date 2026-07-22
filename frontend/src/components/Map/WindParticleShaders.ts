/**
 * GLSL shaders for the animated wind-particle overlay.
 *
 * Ported / adapted from Vladimir Agafonkin's canonical webgl-wind demo
 * (github.com/mapbox/webgl-wind, ISC-licensed).
 *
 * How the pipeline fits together:
 *
 *   1. WIND FIELD (input texture)
 *      RGB values encode (u, v) wind components mapped from
 *      [u_wind_min..u_wind_max] into 0..1. Nulls / no-data cells are (0, 0).
 *
 *   2. PARTICLE POSITIONS (state texture, ping-pong)
 *      RGBA-encodes each particle's (x, y) position in bbox-normalized
 *      space using two bytes per axis for sub-pixel precision:
 *          R = fract(x * 255)  · low byte of x
 *          B = floor(x * 255) / 255  · high byte of x
 *          G/A = same for y
 *
 *   3. UPDATE PASS (update.frag)
 *      Reads current particle position + samples the wind field at that
 *      position, moves the particle by the wind vector, and randomly
 *      respawns a fraction of particles (skewed higher in low-wind cells
 *      so they stay uniformly distributed).
 *
 *   4. DRAW PASS (draw.vert/draw.frag)
 *      Renders each particle as a point. Vertex shader looks up the
 *      position from the state texture, converts bbox-space → lat/lon →
 *      web-mercator → clip space via the Mapbox projection matrix.
 *      Fragment shader colours the point by wind speed using a small
 *      inline SSHWS ramp.
 *
 *   5. SCREEN PASS (quad.vert/screen.frag)
 *      Composites: draws the previous frame's buffer over the map with a
 *      slight opacity fade so recent particle positions leave trails, then
 *      the newly-drawn points overwrite them.
 */

export const UPDATE_FRAG = /* glsl */`
precision highp float;

uniform sampler2D u_particles;
uniform sampler2D u_wind;
uniform vec2 u_wind_res;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform float u_rand_seed;
uniform float u_speed_factor;
uniform float u_drop_rate;
uniform float u_drop_rate_bump;

varying vec2 v_tex_pos;

// Pseudo-random number generator. Not cryptographically secure — but for a
// visual effect we just need reasonable uniformity.
const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
float rand(const vec2 co) {
    float t = dot(rand_constants.xy, co);
    return fract(sin(t) * (rand_constants.z + t));
}

// Bilinear interpolation of the wind vector at (uv), where (uv) is in
// bbox-normalized [0,1] space.
vec2 lookup_wind(const vec2 uv) {
    vec2 px = 1.0 / u_wind_res;
    vec2 vc = (floor(uv * u_wind_res)) * px;
    vec2 f = fract(uv * u_wind_res);
    vec2 tl = texture2D(u_wind, vc).rg;
    vec2 tr = texture2D(u_wind, vc + vec2(px.x, 0)).rg;
    vec2 bl = texture2D(u_wind, vc + vec2(0, px.y)).rg;
    vec2 br = texture2D(u_wind, vc + px).rg;
    vec2 top = mix(tl, tr, f.x);
    vec2 bot = mix(bl, br, f.x);
    return mix(top, bot, f.y);
}

void main() {
    // Decode current position from RGBA (two bytes per axis).
    vec4 color = texture2D(u_particles, v_tex_pos);
    vec2 pos = vec2(
        color.r / 255.0 + color.b,
        color.g / 255.0 + color.a
    );

    // Sample wind at the current position, un-map from 0..1 back to
    // physical u/v (kt or m/s — either works as a scalar).
    vec2 velocity = mix(u_wind_min, u_wind_max, lookup_wind(pos));
    float speed_t = length(velocity) / length(u_wind_max);

    // Advect. Flip the meridional component because texture-space y is
    // down but our v is positive-northward.
    vec2 offset = vec2(velocity.x, -velocity.y) * 0.0001 * u_speed_factor;
    pos = fract(1.0 + pos + offset);

    // Random re-seed. Slow cells get a boosted drop rate so the particle
    // distribution doesn't slowly pile up in calm regions.
    vec2 seed = (pos + v_tex_pos) * u_rand_seed;
    float drop_rate = u_drop_rate + speed_t * u_drop_rate_bump;
    vec2 random_pos = vec2(rand(seed + 1.3), rand(seed + 2.1));
    float drop = step(1.0 - drop_rate, rand(seed));
    pos = mix(pos, random_pos, drop);

    // Encode back to RGBA. This is the two-byte encoding — see file header.
    gl_FragColor = vec4(
        fract(pos * 255.0),
        floor(pos * 255.0) / 255.0
    );
}
`;

export const DRAW_VERT = /* glsl */`
precision mediump float;

attribute float a_index;

uniform sampler2D u_particles;
uniform float u_particles_res;

uniform vec4 u_bbox;         // west, south, east, north
uniform mat4 u_matrix;       // mapbox projection matrix (mercator → clip)

varying vec2 v_particle_pos;

// Web-Mercator projection of a lat/lon in degrees to Mapbox mercator
// coordinates in [0, 1]. Matches mapboxgl.MercatorCoordinate.fromLngLat.
vec2 lngLatToMercator(vec2 lngLat) {
    float x = (lngLat.x + 180.0) / 360.0;
    float sinLat = sin(radians(lngLat.y));
    float y = 0.5 - 0.25 * log((1.0 + sinLat) / (1.0 - sinLat)) / 3.141592653589793;
    return vec2(x, y);
}

void main() {
    vec4 color = texture2D(u_particles, vec2(
        fract(a_index / u_particles_res),
        floor(a_index / u_particles_res) / u_particles_res
    ));

    // Decode two-byte position.
    v_particle_pos = vec2(
        color.r / 255.0 + color.b,
        color.g / 255.0 + color.a
    );

    // v_particle_pos is bbox-normalized. Convert to lat/lon, then to
    // mercator, then to clip space via Mapbox's matrix.
    vec2 lngLat = vec2(
        mix(u_bbox.x, u_bbox.z, v_particle_pos.x),
        mix(u_bbox.y, u_bbox.w, v_particle_pos.y)
    );
    vec2 merc = lngLatToMercator(lngLat);
    gl_Position = u_matrix * vec4(merc, 0.0, 1.0);
    gl_PointSize = 1.5;
}
`;

export const DRAW_FRAG = /* glsl */`
precision mediump float;

uniform sampler2D u_wind;
uniform vec2 u_wind_min;
uniform vec2 u_wind_max;
uniform sampler2D u_color_ramp;

varying vec2 v_particle_pos;

void main() {
    vec2 velocity = mix(u_wind_min, u_wind_max, texture2D(u_wind, v_particle_pos).rg);
    float speed_t = length(velocity) / length(u_wind_max);
    vec2 ramp_pos = vec2(fract(16.0 * speed_t), floor(16.0 * speed_t) / 16.0);
    gl_FragColor = texture2D(u_color_ramp, ramp_pos);
}
`;

export const QUAD_VERT = /* glsl */`
precision mediump float;

attribute vec2 a_pos;
varying vec2 v_tex_pos;

void main() {
    v_tex_pos = a_pos;
    gl_Position = vec4(1.0 - 2.0 * a_pos, 0.0, 1.0);
}
`;

export const SCREEN_FRAG = /* glsl */`
precision mediump float;

uniform sampler2D u_screen;
uniform float u_opacity;

varying vec2 v_tex_pos;

void main() {
    vec4 color = texture2D(u_screen, 1.0 - v_tex_pos);
    // Fake occlusion — decrease alpha slightly so trails fade to nothing.
    gl_FragColor = vec4(floor(255.0 * color * u_opacity) / 255.0);
}
`;
