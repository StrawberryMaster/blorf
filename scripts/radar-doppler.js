/**
 * radar-doppler.js
 * Handles WebGL Doppler radar (radial velocity) rendering
 */
import { getWindVectorAt } from './cyclone-model.js';
import { getElevationAt } from './terrain-data.js';

// GLSL fragment shader
const fsSource = `
    precision highp float;

    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_radar_center;
    uniform float u_radar_radius_km;

    uniform int u_has_cyclone;
    uniform vec2 u_cyc_pos;
    uniform float u_cyc_size;
    uniform float u_cyc_intensity;
    uniform float u_cyc_age;

    uniform vec4 u_sys_params[20];
    uniform float u_sys_strength[20];

    uniform int u_sys_count;
    uniform sampler2D u_terrain_map; // terrain

    const float PI = 3.14159265359;
    const float NYQUIST_VELOCITY = 50.0; // max unambiguous velocity in m/s (~97 kts)

    // velocity aliasing
    float foldVelocity(float v) {
        // maps velocity into the [-Vmax, +Vmax] range
        // core formula: mod(v + Vmax, 2 * Vmax) - Vmax
        return mod(v + NYQUIST_VELOCITY, 2.0 * NYQUIST_VELOCITY) - NYQUIST_VELOCITY;
    }

    // color mapping: velocity ramp
    // inbound (negative): cool colors (green/blue) -> towards radar
    // outbound (positive): warm colors (red/orange) -> away from radar
    vec4 getVelocityColor(float v) {
        // filter threshold
        // here, tiny velocities display as transparent grey (simulates calm wind/clutter suppression)
        if (abs(v) < 1.5) {
            return vec4(0.6, 0.6, 0.6, 0.2);
        }

        vec3 col = vec3(0.0);

        if (v < 0.0) {
            // inbound (negative)
            float av = abs(v);
            if (av < 10.0) {
                col = mix(vec3(0.6, 0.8, 0.6), vec3(0.0, 0.8, 0.0), av / 10.0);
            } else if (av < 20.0) {
                col = mix(vec3(0.0, 0.8, 0.0), vec3(0.0, 0.4, 0.0), (av - 10.0) / 10.0);
            } else if (av < 30.0) {
                col = mix(vec3(0.0, 0.4, 0.0), vec3(0.0, 0.6, 1.0), (av - 20.0) / 10.0);
            } else if (av < 40.0) {
                col = mix(vec3(0.0, 0.6, 1.0), vec3(0.0, 0.0, 0.8), (av - 30.0) / 10.0);
            } else {
                col = mix(vec3(0.0, 0.0, 0.8), vec3(0.6, 0.0, 1.0), clamp((av - 40.0) / 10.0, 0.0, 1.0));
            }
        } else {
            // outbound (positive)
            if (v < 10.0) {
                col = mix(vec3(0.8, 0.8, 0.6), vec3(1.0, 0.8, 0.0), v / 10.0);
            } else if (v < 20.0) {
                col = mix(vec3(1.0, 0.8, 0.0), vec3(1.0, 0.5, 0.0), (v - 10.0) / 10.0);
            } else if (v < 30.0) {
                col = mix(vec3(1.0, 0.5, 0.0), vec3(1.0, 0.0, 0.0), (v - 20.0) / 10.0);
            } else if (v < 40.0) {
                col = mix(vec3(1.0, 0.0, 0.0), vec3(0.5, 0.0, 0.0), (v - 30.0) / 10.0);
            } else {
                col = mix(vec3(0.5, 0.0, 0.0), vec3(1.0, 0.6, 1.0), clamp((v - 40.0) / 10.0, 0.0, 1.0));
            }
        }

        return vec4(col, 0.9);
    }

    // physics helper functions
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

    void main() {
        vec2 offset = (gl_FragCoord.xy / u_resolution) - vec2(0.5);

        // circular mask
        if (length(offset) * 2.0 > 0.98) discard;

        // physical distance mapping
        vec2 px_offset_km = offset * (u_radar_radius_km * 2.0);
        vec2 world_pos = vec2(u_radar_center.x + px_offset_km.x / 111.0, u_radar_center.y + px_offset_km.y / 111.0);

        // get real wind vector (u, v) in m/s
        vec2 wind = getWindVector(world_pos);

        // calculate radar line-of-sight direction (radar beam direction)
        vec2 beam_dir = normalize(offset);

        // calculate true radial velocity
        // positive = away (red), negative = towards (green)
        float radial_v = dot(wind, beam_dir);

        // apply velocity aliasing
        float folded_v = foldVelocity(radial_v);

        gl_FragColor = getVelocityColor(folded_v);
    }
`;

const vsSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

// WebGL renderer class
export class DopplerRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl');

        this.sysParamsCache = new Float32Array(20 * 4);
        this.sysStrengthCache = new Float32Array(20);

        if (!this.gl) {
            console.error("WebGL not supported for Doppler");
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
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

        this.a_position = gl.getAttribLocation(this.program, "a_position");

        this.u_resolution = gl.getUniformLocation(this.program, "u_resolution");
        this.u_time = gl.getUniformLocation(this.program, "u_time");
        this.u_radar_center = gl.getUniformLocation(this.program, "u_radar_center");
        this.u_radar_radius_km = gl.getUniformLocation(this.program, "u_radar_radius_km");

        this.u_sys_params = gl.getUniformLocation(this.program, "u_sys_params");
        this.u_sys_strength = gl.getUniformLocation(this.program, "u_sys_strength");
        this.u_sys_count = gl.getUniformLocation(this.program, "u_sys_count");
        this.u_terrain_map = gl.getUniformLocation(this.program, "u_terrain_map");
        this.terrainTexture = gl.createTexture();

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

    render(state, width, height) {
        const gl = this.gl;
        gl.viewport(0, 0, width, height);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (state.cyclone && state.cyclone.status === 'dissipated') return;

        gl.useProgram(this.program);

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
