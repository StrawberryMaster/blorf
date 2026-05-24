/**
 * RADAR SYSTEM PRECIPITATION ENHANCEMENT
 *
 * KEY IMPROVEMENTS FOR MONSOON DEPRESSIONS & WET TYPHOONS:
 * 1. MOISTURE-BASED PRECIPITATION EXPANSION
 * 2. MULTI-LAYER PRECIPITATION STRUCTURE
 * 3. MONSOON DEPRESSION CHARACTERISTICS
 */
import { getWindVectorAt } from './cyclone-model.js';
import { getElevationAt } from './terrain-data.js';
import { calculateBackgroundHumidity } from './visualization.js';

// GLSL fragment shader
const fsSource = `
    precision highp float;

    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_radar_center;
    uniform float u_radar_radius_km;
    uniform float u_noise_seed;

    uniform int u_has_cyclone;
    uniform vec2 u_cyc_pos;
    uniform float u_cyc_size;
    uniform float u_cyc_intensity;
    uniform float u_cyc_age;
    uniform int u_is_monsoon_depression;

    uniform vec4 u_sys_params[20];
    uniform float u_sys_strength[20];
    uniform float u_env_humidity;
    uniform int u_sys_count;
    uniform sampler2D u_terrain_map;

    const float PI = 3.14159265359;

    float random(vec2 p) {
        vec2 p2 = p + vec2(u_noise_seed);
        vec3 p3 = fract(vec3(p2.xyx) * .1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.y * u.x;
    }

    float fbm(vec2 st, int octaves) {
        float value = 0.0;
        float amp = 0.5;
        value += noise(st) * amp; st *= 2.0; amp *= 0.5;
        value += noise(st) * amp; st *= 2.0; amp *= 0.5;
        if (octaves > 2) {
             value += noise(st) * amp; st *= 2.0; amp *= 0.5;
        }
        return value;
    }

    vec4 getRadarColor(float dbz) {
        if (dbz < 15.0) return vec4(0.0);
        if (dbz < 20.0) return vec4(0.0, 0.65, 0.95, 0.35);
        if (dbz < 30.0) return vec4(0.0, 0.85, 0.0, 0.55);
        if (dbz < 40.0) return vec4(0.0, 0.60, 0.0, 0.7);
        if (dbz < 45.0) return vec4(1.0, 1.0, 0.0, 0.8);
        if (dbz < 50.0) return vec4(1.0, 0.65, 0.0, 0.9);
        if (dbz < 55.0) return vec4(1.0, 0.1, 0.1, 0.95);
        if (dbz < 60.0) return vec4(0.9, 0.0, 0.0, 0.95);
        if (dbz < 65.0) return vec4(1.0, 0.0, 0.9, 1.0);
        if (dbz < 70.0) return vec4(0.6, 0.0, 0.2, 1.0);
        return vec4(0.9, 0.9, 1.0, 1.0);
    }

    float getElevation(vec2 pos) {
        vec2 uv = fract(vec2((pos.x + 180.0) / 360.0, (90.0 - pos.y) / 180.0));
        float val = texture2D(u_terrain_map, uv).r;
        return val * 680.0;
    }

    float getPressure(vec2 pos) {
        float p = 0.0;
        for (int i = 0; i < 20; i++) {
            if (i >= u_sys_count) break;
            vec4 params = u_sys_params[i];
            float dx = abs(pos.x - params.x);
            if (dx > 180.0) dx = 360.0 - dx;
            float dy = pos.y - params.y;
            p += u_sys_strength[i] * exp(-0.5 * ((dx*dx)/(params.z*params.z) + (dy*dy)/(params.w*params.w)));
        }
        return 1012.0 + p;
    }

    vec2 getWindVector(vec2 pos) {
        float dDeg = 0.5;
        float p_x_plus = getPressure(pos + vec2(dDeg, 0.0));
        float p_x_minus = getPressure(pos - vec2(dDeg, 0.0));
        float p_y_plus = getPressure(pos + vec2(0.0, dDeg));
        float p_y_minus = getPressure(pos - vec2(0.0, dDeg));

        vec2 wind_bg = vec2(-(p_y_plus - p_y_minus), p_x_plus - p_x_minus) * 4.0 * sign(pos.y + 0.0001);
        vec2 wind_cyc = vec2(0.0);

        if (u_has_cyclone > 0) {
            vec2 offset_deg = pos - u_cyc_pos;
            float dx_km = offset_deg.x * 111.0 * cos(radians(u_cyc_pos.y));
            float dy_km = offset_deg.y * 111.0;
            float dist = sqrt(dx_km*dx_km + dy_km*dy_km);
            float rmw = 20.0 + u_cyc_size * 0.15;

            if (dist < u_cyc_size * 4.0) {
                float intensity = u_cyc_intensity * 0.514;
                float v_tan = dist < rmw ? intensity * (dist / rmw) : intensity * pow(rmw / dist, 0.6);
                float wind_angle = atan(dy_km, dx_km) + (u_cyc_pos.y >= 0.0 ? 1.5708 : -1.5708);
                wind_cyc = vec2(cos(wind_angle), sin(wind_angle)) * v_tan;
            }
        }
        return wind_bg + wind_cyc;
    }

    float calculateStratiformRain(float dist_rmw, float humidity, float intensity, vec2 world_pos, float angle, float rotOffset) {
        if (humidity < 0.55) return 0.0;
        float stratRange = smoothstep(1.5, 2.5, dist_rmw) * (1.0 - smoothstep(5.0, 8.0, dist_rmw));
        float moistureBoost = smoothstep(0.55, 0.85, humidity) * 1.5;
        float cloudNoise = fbm(world_pos * 1.5, 3);
        float baseDbz = 18.0 + 17.0 * cloudNoise;
        return baseDbz * stratRange * moistureBoost;
    }

    float calculateFeederBands(float dist_rmw, float humidity, vec2 world_pos, float angle, float rotOffset) {
        if (humidity < 0.70 || dist_rmw < 5.0 || dist_rmw > 12.0) return 0.0;
        float spiralMask = smoothstep(-0.3, 0.4, sin(angle * 3.0 + dist_rmw * 0.8 + rotOffset));
        float cloudTexture = fbm(world_pos * 2.0, 2);
        float fadein = smoothstep(5.0, 6.5, dist_rmw);
        float fadeout = 1.0 - smoothstep(10.0, 12.0, dist_rmw);
        float moistureFactor = smoothstep(0.70, 0.90, humidity);
        return (12.0 + 8.0 * cloudTexture) * spiralMask * fadein * fadeout * moistureFactor;
    }

    float calculateMonsoonPrecip(float dist_km, float humidity, vec2 world_pos, float intensity) {
        float maxRange = 400.0 + (intensity - 20.0) * 3.0;
        if (dist_km > maxRange) return 0.0;

        float radialFalloff = pow(1.0 - smoothstep(0.0, maxRange, dist_km), 0.4);
        float cloudStructure = fbm(world_pos * 0.8, 3) * 0.6 + fbm(world_pos * 2.5, 2) * 0.4;
        float moistureEffect = smoothstep(0.60, 0.85, humidity);
        float centralBoost = 1.0 + 0.3 * smoothstep(250.0, 50.0, dist_km);

        return (22.0 + 25.0 * cloudStructure) * radialFalloff * moistureEffect * centralBoost;
    }

    void main() {
        vec2 st = gl_FragCoord.xy / u_resolution;
        vec2 offset = st - vec2(0.5);
        float angle_rad = atan(offset.y, offset.x);
        float max_radius = 0.97 + 0.03 * fbm(vec2(angle_rad * 10.0, u_time * 0.1), 2);
        float dist_ratio = length(offset) * 2.0;

        if (dist_ratio > max_radius) discard;

        float dist_km = dist_ratio * u_radar_radius_km;
        vec2 px_offset_km = offset * (u_radar_radius_km * 2.0);
        vec2 world_pos = vec2(u_radar_center.x + px_offset_km.x / 111.0, u_radar_center.y + px_offset_km.y / 111.0);

        vec2 wind = getWindVector(world_pos);
        float wind_speed = length(wind);

        float elev = getElevation(world_pos);
        float lift_factor = 0.0;
        float baseHum = (u_env_humidity > 0.0) ? u_env_humidity : 0.7;

        if (wind_speed > 10.0) {
            float step = 0.11;
            float grad_x = getElevation(world_pos + vec2(step, 0.0)) - elev;
            float grad_y = getElevation(world_pos + vec2(0.0, step)) - elev;
            float terrainSteepness = smoothstep(0.00, 0.02, sqrt(grad_x * grad_x + grad_y * grad_y));

            if (terrainSteepness > 0.0) {
                float dot_val = dot(wind, vec2(grad_x, grad_y));
                if (dot_val > 0.0) {
                    lift_factor = dot_val * 0.15 * smoothstep(0.35, 0.75, max(baseHum, 0.85)) * terrainSteepness;
                }
            }
        }

        float dbz = 0.0;

        // cyclone precipitation
        if (u_has_cyclone > 0) {
            float hemi = (u_cyc_pos.y >= 0.0) ? 1.0 : -1.0;
            vec2 cyc_offset_deg = world_pos - u_cyc_pos;
            vec2 cyc_offset_km = vec2(cyc_offset_deg.x * 111.0 * cos(radians(u_cyc_pos.y)), cyc_offset_deg.y * 111.0);
            float c_dist = length(cyc_offset_km);

            if (u_is_monsoon_depression > 0) {
                dbz = calculateMonsoonPrecip(c_dist, baseHum, world_pos, u_cyc_intensity);
            } else {
                if (c_dist < u_cyc_size * 4.5) {
                    float intensity = u_cyc_intensity;
                    float org = clamp((intensity - 25.0) / 85.0, 0.01, 0.99);
                    float angle = atan(cyc_offset_km.y, cyc_offset_km.x);
                    float rotOffset = u_cyc_age * 0.2 * hemi;
                    float rmw = (20.0 + u_cyc_size * 0.12) * (1.8 - 0.7 * org);
                    float d = c_dist / rmw;

                    float biasAngle = rotOffset * 0.7 + PI;
                    float asymmetry = max(0.2, 1.0 + 0.7 * (1.0 - org) * cos(angle - biasAngle));
                    float highFreqNoise = fbm(world_pos * 20.0 + u_time * 0.1, 2);

                    // inner core (eyewall)
                    float spiralPhase = angle + hemi * (1.0 + org * 3.0) * log(d + 0.1);
                    float warp = fbm(world_pos * 3.0, 3) * (1.5 - org) * min(2.0, d);
                    float shapeDistort = fbm(world_pos * 4.0 + vec2(u_cyc_age*0.05, 0.0), 2);
                    float signal = smoothstep(-0.3, 0.7, sin(spiralPhase * 2.0 + rotOffset + warp + shapeDistort * 0.1));

                    float eyewallShape = exp(-pow(d - 1.0, 4.0) / ((0.20 - 0.10 * (1.0 - org)) * (0.8 + 0.4 * highFreqNoise))) * (1.0 + 0.3 * (intensity - 85.0) / 85.0);
                    float moatBreaker = fbm(vec2(angle * 1.5, u_cyc_age * 0.01), 2) * (2.0 - asymmetry);
                    float connFactor = 1.0 - (smoothstep(1.4, 1.7, d) * (1.0 - smoothstep(2.2, 2.7, d)) * smoothstep(0.3, 0.9, moatBreaker) * smoothstep(0.4, 0.8, org));

                    float strongCore = 45.0 * eyewallShape * (0.95 + 0.1 * smoothstep(0.25, 0.6, highFreqNoise)) + fbm(world_pos * 8.0 + rotOffset, 2) * 15.0 * eyewallShape;

                    if (d < 0.5 && org > 0.5) {
                        strongCore *= (1.0 - smoothstep(0.5, 0.0, d) * smoothstep(0.5, 0.9, org) * 0.9);
                        if (strongCore < 10.0) strongCore += fbm(world_pos * 40.0, 2) * 8.0;
                    }

                    // weak system structure
                    float twist = 3.0 * (1.0 - d);
                    vec2 twistedPos = vec2(world_pos.x * cos(twist + rotOffset) - world_pos.y * sin(twist + rotOffset), world_pos.x * sin(twist + rotOffset) + world_pos.y * cos(twist + rotOffset));
                    float noiseBase = fbm(twistedPos * 3.0, 3);
                    float rangeMask = 1.0 - smoothstep(0.5, mix(1.2, 3.5, smoothstep(0.0, 0.6, org)), d);
                    float weakCore = (org < 0.15 ? 30.0 * smoothstep(0.6, 0.8, noiseBase) : 35.0 * noiseBase * smoothstep(-0.5, 0.8, cos(angle - biasAngle) + 0.3 * noiseBase)) * rangeMask;

                    float coreDbz = mix(weakCore, strongCore, smoothstep(0.3, 0.7, org));

                    float eyeFillFactor = 1.0 - smoothstep(0.4, 0.65, org);
                    if (eyeFillFactor > 0.0 && d < 2.5) {
                        float blobShape = smoothstep(2.5, 0.2, length(cyc_offset_km / rmw + vec2(fbm(world_pos * 1.5 + u_cyc_age * 0.05, 2) - 0.5, fbm(world_pos * 1.5 + u_cyc_age * 0.05 + 50.0, 2) - 0.5) * 0.8) + fbm(world_pos * 4.0, 3) * 0.5);
                        if (blobShape > 0.0) coreDbz = max(coreDbz, 60.0 * fbm(world_pos * 8.0 + u_cyc_age * 0.1, 2) * blobShape * eyeFillFactor);
                    }

                    // primary rain bands
                    float bandAsym = asymmetry < 0.6 ? asymmetry * (0.5 + 0.5 * fbm(world_pos * 10.0, 2)) : asymmetry;
                    float convMask = smoothstep(0.6, 0.9, signal) * smoothstep(0.4, 0.7, fbm(world_pos * 8.0, 3));
                    float stratiform = 15.0 + 20.0 * smoothstep(-0.5, 0.5, signal);
                    float convective = convMask > 0.1 ? 30.0 + 25.0 * convMask : 0.0;

                    if (asymmetry < 0.6) {
                        bandAsym *= (0.6 + 0.4 * fbm(world_pos * 8.0, 2));
                        stratiform *= 0.6; convective *= 0.3;
                    }

                    float bandDbz = max(stratiform, convective) * exp(-max(0.0, d - 1.0) / mix(1.8, 5.0, smoothstep(0.1, 0.7, org))) * connFactor * bandAsym * smoothstep(0.4, 0.8, d);
                    dbz = max(coreDbz, bandDbz);

                    if (d > 1.5 && dbz > 0.0) dbz += (fbm(world_pos * 12.0, 2) - 0.4) * 20.0;

                    // stratiform & feeder bands
                    dbz = max(dbz, calculateStratiformRain(d, baseHum, intensity, world_pos, angle, rotOffset));
                    dbz = max(dbz, calculateFeederBands(d, baseHum, world_pos, angle, rotOffset));

                    // moisture modulation
                    float globalHum = clamp(baseHum, 0.0, 1.0);
                    dbz -= (1.0 - smoothstep(0.2, 0.7, globalHum)) * 4.0 * (240.0 - intensity) / 160.0 * smoothstep(0.5, 3.0, d);
                    dbz = max(0.0, dbz);

                    float maxSupportableDbz = globalHum * 70.0 + 5.0;
                    if (dbz > maxSupportableDbz) dbz = mix(dbz, maxSupportableDbz, 0.2);
                }
            }
        }

        // environmental thunderstorms
        vec2 windOffset = (wind + 5.0) * u_time * 0.05;
        float stormStructure = fbm((world_pos * 0.6) - windOffset * 0.5, 2) * fbm((world_pos * 5.0) - windOffset, 2) * 2.5;
        float baseThreshold = 0.6 - (baseHum * 0.4);

        if (stormStructure > baseThreshold) {
            float intensity = pow((stormStructure - baseThreshold) / (1.0 - baseThreshold), 1.5);
            dbz = max(dbz, (60.0 * intensity + 5.0 * random((world_pos * 5.0) - windOffset)) * smoothstep(0.4, 0.8, baseHum));
        }

        gl_FragColor = getRadarColor(max(0.0, dbz + lift_factor * 0.16));
    }
`;

const vsSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

// calculation helpers
const GLSL = {
    f32: (x) => Math.fround(x),
    fract: (x) => { const f = Math.fround(x); return Math.fround(f - Math.floor(f)); },
    mix: (a, b, t) => {
        const fa = Math.fround(a), fb = Math.fround(b), ft = Math.fround(Math.max(0, Math.min(1, t)));
        return Math.fround(fa + (fb - fa) * ft);
    },
    clamp: (x, min, max) => Math.fround(Math.max(min, Math.min(max, x))),
    smoothstep: (edge0, edge1, x) => {
        const f0 = Math.fround(edge0), f1 = Math.fround(edge1), fx = Math.fround(x);
        const t = Math.fround(Math.max(0, Math.min(1, (fx - f0) / (f1 - f0))));
        return Math.fround(t * t * (3.0 - 2.0 * t));
    },
    length: (x, y) => Math.fround(Math.sqrt(Math.fround(x * x + y * y))),

    // hash12 matching shader implementation
    random: (x, y, seed = 0.0) => {
        const px = Math.fround(x + seed);
        const py = Math.fround(y + seed);

        let p3x = Math.fround(GLSL.fract(Math.fround(px * 0.1031)));
        let p3y = Math.fround(GLSL.fract(Math.fround(py * 0.1031)));
        let p3z = Math.fround(GLSL.fract(Math.fround(px * 0.1031)));

        const dotVal = Math.fround(
            Math.fround(p3x * Math.fround(p3y + 33.33)) +
            Math.fround(p3y * Math.fround(p3z + 33.33)) +
            Math.fround(p3z * Math.fround(p3x + 33.33))
        );
        p3x = Math.fround(p3x + dotVal);
        p3y = Math.fround(p3y + dotVal);
        p3z = Math.fround(p3z + dotVal);

        return Math.fround(GLSL.fract(Math.fround(Math.fround(p3x + p3y) * p3z)));
    },

    noise: (x, y, seed) => {
        const ix = Math.floor(x), iy = Math.floor(y);
        const fx = GLSL.fract(x), fy = GLSL.fract(y);
        const a = GLSL.random(ix, iy, seed);
        const b = GLSL.random(ix + 1.0, iy, seed);
        const c = GLSL.random(ix, iy + 1.0, seed);
        const d = GLSL.random(ix + 1.0, iy + 1.0, seed);
        const ux = Math.fround(fx * fx * (3.0 - 2.0 * fx));
        const uy = Math.fround(fy * fy * (3.0 - 2.0 * fy));
        const mix1 = GLSL.mix(a, b, ux);
        const term2 = Math.fround((c - a) * uy * (1.0 - ux));
        const term3 = Math.fround((d - b) * uy * ux);
        return Math.fround(mix1 + term2 + term3);
    },
    fbm: (x, y, octaves = 2, seed = 0.0) => {
        let value = 0.0;
        let amp = 0.5;
        let px = x, py = y;
        for (let i = 0; i < octaves; i++) {
            value = Math.fround(value + GLSL.noise(px, py, seed) * amp);
            px = Math.fround(px * 2.0);
            py = Math.fround(py * 2.0);
            amp = Math.fround(amp * 0.5);
        }
        return value;
    }
};

export function getShaderPressure(lon, lat, pressureSystems) {
    let p = 0.0;
    const limit = Math.min(pressureSystems.length, 20);
    for (let i = 0; i < limit; i++) {
        const sys = pressureSystems[i];
        let dx = Math.abs(lon - sys.x);
        if (dx > 180.0) { dx = 360.0 - dx; }
        const dy = lat - sys.y;
        p += sys.strength * Math.exp(-0.5 * ( (dx*dx)/(sys.sigmaX*sys.sigmaX) + (dy*dy)/(sys.sigmaY*sys.sigmaY) ));
    }
    return 1012.0 + p;
}

export function getShaderWindVector(lon, lat, cyclone, pressureSystems) {
    const dDeg = 0.5;
    const p_x_plus = getShaderPressure(lon + dDeg, lat, pressureSystems);
    const p_x_minus = getShaderPressure(lon - dDeg, lat, pressureSystems);
    const p_y_plus = getShaderPressure(lon, lat + dDeg, pressureSystems);
    const p_y_minus = getShaderPressure(lon, lat - dDeg, pressureSystems);
    const gradX = p_x_plus - p_x_minus;
    const gradY = p_y_plus - p_y_minus;
    const f_sign = lat >= 0.0 ? 1.0 : -1.0;
    const bgScale = 4.0;
    const u_bg = -gradY * bgScale * f_sign;
    const v_bg = gradX * bgScale * f_sign;

    let u_cyc = 0.0, v_cyc = 0.0;
    if (cyclone && cyclone.status === 'active') {
        const dx = lon - cyclone.lon;
        const cycLatRad = cyclone.lat * Math.PI / 180.0;
        const dx_km = dx * 111.0 * Math.cos(cycLatRad);
        const dy_km = (lat - cyclone.lat) * 111.0;
        const dist = Math.sqrt(dx_km*dx_km + dy_km*dy_km);
        const rmw = 20.0 + cyclone.circulationSize * 0.15;

        if (dist < cyclone.circulationSize * 4.0) {
            const intensity = cyclone.intensity * 0.514;
            const v_tan = dist < rmw ? intensity * (dist / rmw) : intensity * Math.pow(rmw / dist, 0.6);
            const wind_angle = Math.atan2(dy_km, dx_km) + (cyclone.lat >= 0.0 ? 1.5708 : -1.5708);
            u_cyc = Math.cos(wind_angle) * v_tan;
            v_cyc = Math.sin(wind_angle) * v_tan;
        }
    }
    return { u: u_bg + u_cyc, v: v_bg + v_cyc, magnitude: Math.sqrt((u_bg+u_cyc)**2 + (v_bg+v_cyc)**2) };
}

export function calculateRadarDbz(lon, lat, state, seed = 0.0) {
    const u_time = (state.cyclone && state.cyclone.status === 'active') ? state.cyclone.age : 0;
    const PI = Math.PI;

    const elev = getElevationAt(lon, lat);
    const vec = getShaderWindVector(lon, lat, state.cyclone, state.pressureSystems);
    const windSpeed = vec.magnitude;
    const windX = vec.u, windY = vec.v;

    const effectiveHum = (state.u_env_humidity !== undefined) ? state.u_env_humidity :
        calculateBackgroundHumidity(lon, lat, state.pressureSystems, state.currentMonth, state.cyclone, state.GlobalTemp) / 100.0;

    let lift_factor = 0.0;
    if (windSpeed > 10.0) {
        const step = 0.11;
        const gradX = getElevationAt(lon + step, lat) - elev;
        const gradY = getElevationAt(lon, lat + step) - elev;
        const slopeMagnitude = Math.sqrt(gradX*gradX + gradY*gradY);
        const terrainSteepness = GLSL.smoothstep(0.00, 0.02, slopeMagnitude);
        if (terrainSteepness > 0.0) {
            const dotVal = windX * gradX + windY * gradY;
            if (dotVal > 0) {
                const moistureEfficiency = GLSL.smoothstep(0.35, 0.75, effectiveHum);
                lift_factor = dotVal * 0.15 * moistureEfficiency * terrainSteepness;
            }
        }
    }

    let dbz = 0.0;

    if (state.cyclone && state.cyclone.status === 'active') {
        const cyc = state.cyclone;
        const u_cyc_posX = cyc.lon, u_cyc_posY = cyc.lat;
        const u_cyc_size = cyc.circulationSize;
        const u_cyc_intensity = cyc.intensity;
        const u_cyc_age = cyc.age;
        const hemi = (u_cyc_posY >= 0.0) ? 1.0 : -1.0;

        const dx = (lon - u_cyc_posX) * 111.0 * Math.cos(u_cyc_posY * PI / 180.0);
        const dy = (lat - u_cyc_posY) * 111.0;
        const c_dist = GLSL.length(dx, dy);

        if (c_dist < u_cyc_size * 3.5) {
            const org = GLSL.clamp((u_cyc_intensity - 25.0) / 85.0, 0.01, 0.99);
            const angle = Math.atan2(dy, dx);
            const rotOffset = u_cyc_age * 0.2 * hemi;
            const rmw = (20.0 + u_cyc_size * 0.12) * (1.8 - 0.7 * org);
            const d = c_dist / rmw;

            const biasAngle = rotOffset * 0.7 + PI;
            const angleDiff = Math.cos(angle - biasAngle);
            let asymmetry = Math.max(0.2, 1.0 + 0.7 * (1.0 - org) * angleDiff);

            const highFreqNoise = GLSL.fbm(lon * 20.0 + u_time * 0.1, lat * 20.0 + u_time * 0.1, 2, seed);
            const shapeDistort = GLSL.fbm(lon * 4.0 + u_cyc_age*0.05, lat * 4.0, 2, seed);

            const spiralPhase = angle + hemi * (1.0 + org * 3.0) * Math.log(d + 0.1);
            const warp = GLSL.fbm(lon * 3.0, lat * 3.0, 3, seed) * (1.5 - org) * Math.min(2.0, d);

            let signal = GLSL.smoothstep(-0.3, 0.7, Math.sin(spiralPhase * 2.0 + rotOffset + warp + shapeDistort * 0.1));

            const eyewallWidth = (0.20 - 0.10 * (1.0 - org)) * (0.8 + 0.4 * highFreqNoise);
            const eyewallShape = Math.exp(-Math.pow(d - 1.0, 4.0) / eyewallWidth) * (1.0 + 0.3 * (u_cyc_intensity - 85.0) / 85.0);

            const moatBase = GLSL.smoothstep(1.4, 1.7, d) * (1.0 - GLSL.smoothstep(2.2, 2.7, d));
            const moatBreaker = GLSL.fbm(angle * 1.5, u_cyc_age * 0.01, 2, seed) * (2.0 - asymmetry);
            const connFactor = 1.0 - (moatBase * GLSL.smoothstep(0.3, 0.9, moatBreaker) * GLSL.smoothstep(0.4, 0.8, org));

            let strongCore = 45.0 * eyewallShape * (0.95 + 0.1 * GLSL.smoothstep(0.25, 0.6, highFreqNoise)) +
                             GLSL.fbm(lon * 8.0 + rotOffset, lat * 8.0 + rotOffset, 2, seed) * 15.0 * eyewallShape;

            if (d < 0.5 && org > 0.5) {
                strongCore *= (1.0 - GLSL.smoothstep(0.5, 0.0, d) * GLSL.smoothstep(0.5, 0.9, org) * 0.9);
                if (strongCore < 10.0) strongCore += GLSL.fbm(lon * 40.0, lat * 40.0, 2, seed) * 8.0;
            }

            const twist = 3.0 * (1.0 - d);
            const twistedPosX = lon * Math.cos(twist + rotOffset) - lat * Math.sin(twist + rotOffset);
            const twistedPosY = lon * Math.sin(twist + rotOffset) + lat * Math.cos(twist + rotOffset);
            const noiseBase = GLSL.fbm(twistedPosX * 3.0, twistedPosY * 3.0, 3, seed);
            const commaShape = GLSL.smoothstep(-0.5, 0.8, angleDiff + 0.3 * noiseBase);
            const rangeMask = 1.0 - GLSL.smoothstep(0.5, GLSL.mix(1.2, 3.5, GLSL.smoothstep(0.0, 0.6, org)), d);

            let weakCore = org < 0.15 ? 30.0 * GLSL.smoothstep(0.6, 0.8, noiseBase) * rangeMask
                                      : 35.0 * noiseBase * commaShape * rangeMask;

            let coreDbz = GLSL.mix(weakCore, strongCore, GLSL.smoothstep(0.3, 0.7, org));

            const eyeFillFactor = 1.0 - GLSL.smoothstep(0.4, 0.65, org);
            if (eyeFillFactor > 0.0 && d < 2.5) {
                const warpX = GLSL.fbm(lon * 1.5 + u_cyc_age * 0.05, lat * 1.5 + u_cyc_age * 0.05, 2, seed);
                const warpY = GLSL.fbm(lon * 1.5 + u_cyc_age * 0.05 + 50.0, lat * 1.5 + u_cyc_age * 0.05 + 50.0, 2, seed);
                const blobShape = GLSL.smoothstep(2.5, 0.2, GLSL.length(dx / rmw + (warpX - 0.5) * 0.8, dy / rmw + (warpY - 0.5) * 0.8) + GLSL.fbm(lon * 4.0, lat * 4.0, 3, seed) * 0.5);
                if (blobShape > 0.0) {
                    coreDbz = Math.max(coreDbz, 60.0 * GLSL.fbm(lon * 8.0 + u_cyc_age * 0.1, lat * 8.0 + u_cyc_age * 0.1, 2, seed) * blobShape * eyeFillFactor);
                }
            }

            let bandAsym = asymmetry;
            if (asymmetry < 0.6) bandAsym *= (0.5 + 0.5 * GLSL.fbm(lon * 10.0, lat * 10.0, 2, seed));

            let stratiform = 15.0 + 20.0 * GLSL.smoothstep(-0.5, 0.5, signal);
            const convMask = GLSL.smoothstep(0.6, 0.9, signal) * GLSL.smoothstep(0.4, 0.7, GLSL.fbm(lon * 8.0, lat * 8.0, 3, seed));
            let convective = convMask > 0.1 ? 30.0 + 25.0 * convMask : 0.0;

            if (asymmetry < 0.6) {
                asymmetry *= (0.6 + 0.4 * GLSL.fbm(twistedPosX * 3.0, twistedPosY * 3.0, 2, seed));
                stratiform *= 0.6; convective *= 0.3;
            }

            const distFade = Math.exp(-Math.max(0.0, d - 1.0) / GLSL.mix(1.8, 5.0, GLSL.smoothstep(0.1, 0.7, org)));
            let bandDbz = Math.max(stratiform, convective) * distFade * connFactor * bandAsym * GLSL.smoothstep(0.4, 0.8, d);

            dbz = Math.max(coreDbz, bandDbz);

            if (d > 1.5 && dbz > 0.0) {
                dbz += (GLSL.fbm(lon * 12.0, lat * 12.0, 2, seed) - 0.4) * 20.0;
            }

            const globalHum = GLSL.clamp(effectiveHum, 0.0, 1.0);
            dbz -= (1.0 - GLSL.smoothstep(0.2, 0.7, globalHum)) * 4.0 * (240.0 - u_cyc_intensity) / 160.0;
            dbz = Math.max(0.0, dbz);

            const maxSupportableDbz = globalHum * 70.0 + 5.0;
            if (dbz > maxSupportableDbz) dbz = GLSL.mix(dbz, maxSupportableDbz, 0.2);
        }
    }

    // environmental thunderstorms (fallback)
    const windOffsetX = (windX + 5.0) * u_time * 0.05, windOffsetY = (windY + 5.0) * u_time * 0.05;
    const macroNoise = GLSL.fbm((lon * 0.6) - windOffsetX * 0.5, (lat * 0.6) - windOffsetY * 0.5, 2, seed);
    const microPosX = (lon * 5.0) - windOffsetX, microPosY = (lat * 5.0) - windOffsetY;

    const stormStructure = macroNoise * GLSL.fbm(microPosX, microPosY, 2, seed) * 2.5;
    const baseThreshold = 0.6 - (effectiveHum * 0.4);

    if (stormStructure > baseThreshold) {
        let intensity = Math.pow((stormStructure - baseThreshold) / (1.0 - baseThreshold), 1.5);
        let ambientDbz = 60.0 * intensity + 5.0 * GLSL.random(microPosX, microPosY, seed);
        ambientDbz *= GLSL.smoothstep(0.4, 0.8, effectiveHum);
        dbz = Math.max(dbz, ambientDbz);
    }

    return Math.max(0, dbz + lift_factor * 0.16);
}

// WebGL renderer class
export class RadarRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');
        this.sysParamsCache = new Float32Array(20 * 4);
        this.sysStrengthCache = new Float32Array(20);
        if (!this.gl) {
            console.error("WebGL not supported");
            return;
        }
        this.init();
    }

    init() {
        const gl = this.gl;

        const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);
        this.program = this.createProgram(vs, fs);

        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1, 1, -1, -1, 1,
            -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);

        this.a_position = gl.getAttribLocation(this.program, "a_position");

        this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");
        this.u_time = gl.getUniformLocation(this.program, "u_time");
        this.u_radar_center = gl.getUniformLocation(this.program, "u_radar_center");
        this.u_radar_radius_km = gl.getUniformLocation(this.program, "u_radar_radius_km");
        this.u_noise_seed = gl.getUniformLocation(this.program, "u_noise_seed");
        this.u_is_monsoon_depression = gl.getUniformLocation(this.program, "u_is_monsoon_depression");

        this.u_sys_params = gl.getUniformLocation(this.program, "u_sys_params");
        this.u_sys_strength = gl.getUniformLocation(this.program, "u_sys_strength");

        this.u_sys_count = gl.getUniformLocation(this.program, "u_sys_count");
        this.u_terrain_map = gl.getUniformLocation(this.program, "u_terrain_map");
        this.terrainTexture = gl.createTexture();

        this.u_env_humidity = gl.getUniformLocation(this.program, 'u_env_humidity');
        this.u_has_cyclone = gl.getUniformLocation(this.program, "u_has_cyclone");
        this.u_cyc_pos = gl.getUniformLocation(this.program, "u_cyc_pos");
        this.u_cyc_size = gl.getUniformLocation(this.program, "u_cyc_size");
        this.u_cyc_intensity = gl.getUniformLocation(this.program, "u_cyc_intensity");
        this.u_cyc_age = gl.getUniformLocation(this.program, "u_cyc_age");
    }

    loadTerrainTexture(imageElement) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.terrainTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageElement);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    render(state, width, height, envHumidity, noiseSeed = 0.0) {
        const gl = this.gl;

        gl.viewport(0, 0, width, height);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // skip rendering if cyclone dissipated
        if (state.cyclone && state.cyclone.status === 'dissipated') return;

        gl.useProgram(this.program);
        gl.uniform1i(this.u_is_monsoon_depression, state.cyclone?.isMonsoonDepression ? 1 : 0);

        if (state.pressureSystems) {
            const limit = Math.min(state.pressureSystems.length, 20);

            for (let i = 0; i < limit; i++) {
                const p = state.pressureSystems[i];
                const baseIdx = i * 4;
                this.sysParamsCache[baseIdx] = p.x;
                this.sysParamsCache[baseIdx + 1] = p.y;
                this.sysParamsCache[baseIdx + 2] = p.sigmaX;
                this.sysParamsCache[baseIdx + 3] = p.sigmaY;
                this.sysStrengthCache[i] = p.strength;
            }

            gl.uniform4fv(this.u_sys_params, this.sysParamsCache);
            gl.uniform1fv(this.u_sys_strength, this.sysStrengthCache);
            gl.uniform1i(this.u_sys_count, limit);
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.terrainTexture);
        gl.uniform1i(this.u_terrain_map, 0);

        gl.enableVertexAttribArray(this.a_position);
        gl.vertexAttribPointer(this.a_position, 2, gl.FLOAT, false, 0, 0);

        gl.uniform2f(this.u_resolution, width, height);
        gl.uniform1f(this.u_noise_seed, noiseSeed);

        // use cyclone age if active, otherwise use performance.now()
        let shaderTime = (state.cyclone && state.cyclone.status === 'active')
            ? state.cyclone.age
            : performance.now() / 1000.0;

        if (this.u_time) gl.uniform1f(this.u_time, shaderTime);

        gl.uniform2f(this.u_radar_center, state.siteLon, state.siteLat);
        gl.uniform1f(this.u_radar_radius_km, 460.0);

        if (state.cyclone && state.cyclone.status === 'active') {
            gl.uniform1i(this.u_has_cyclone, 1);
            gl.uniform2f(this.u_cyc_pos, state.cyclone.lon, state.cyclone.lat);
            gl.uniform1f(this.u_cyc_size, state.cyclone.circulationSize);
            gl.uniform1f(this.u_cyc_intensity, state.cyclone.intensity);
            gl.uniform1f(this.u_cyc_age, state.cyclone.age);
        } else {
            gl.uniform1i(this.u_has_cyclone, 0);
        }

        gl.uniform1f(this.u_env_humidity, envHumidity !== undefined ? envHumidity : 0.8);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    createShader(type, source) {
        const s = this.gl.createShader(type);
        this.gl.shaderSource(s, source);
        this.gl.compileShader(s);
        if (!this.gl.getShaderParameter(s, this.gl.COMPILE_STATUS)) {
            console.error(this.gl.getShaderInfoLog(s));
            this.gl.deleteShader(s);
            return null;
        }
        return s;
    }

    createProgram(vs, fs) {
        const p = this.gl.createProgram();
        this.gl.attachShader(p, vs);
        this.gl.attachShader(p, fs);
        this.gl.linkProgram(p);
        return p;
    }
}
