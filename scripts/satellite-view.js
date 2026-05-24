/**
 * scripts/satellite-view.js
 * Handles WebGL rendering for the dynamic satellite IR/Visible imagery
 */

let gl, program;
let startTime;
let canvas;
let uniforms = {};
let isGrayscale = false;

// vertex shader
const vertexShaderSource = `
    attribute vec2 a_position;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
    }
`;

// fragment shader
const fragmentShaderSource = `
    precision mediump float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_spiral_strength;
    uniform float u_eye_radius;
    uniform float u_shape_distortion;
    uniform float u_storm_radius;
    uniform float u_cloud_low;
    uniform float u_cloud_high;
    uniform float u_central_mass_size;
    uniform float u_wind_shear_strength;
    uniform float u_random_seed;
    uniform float u_hemisphere;
    uniform float u_grayscale;

    // asymmetry parameters for sheared/extratropical systems
    uniform float u_asym_strength;
    uniform float u_asym_dir;


    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        vec2 u = f * f * (3.0 - 2.0 * f);

        float a = fract(sin(dot(i, vec2(12.9898, 78.233))) * 43758.5453123);
        float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(12.9898, 78.233))) * 43758.5453123);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(12.9898, 78.233))) * 43758.5453123);
        float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(12.9898, 78.233))) * 43758.5453123);

        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.y * u.x;
    }

    float fbm(vec2 st) {
        float value = 0.0;
        value += 0.600 * noise(st); st *= 2.0;
        value += 0.300 * noise(st); st *= 2.0;
        value += 0.150 * noise(st); st *= 2.0;
        value += 0.075 * noise(st);
        return value * 0.8888; // value / 1.125 (max amplitude)
    }

    // NRL/BD curve style color ramp for IR enhancement
    vec3 nrl_color_ramp(float t) {
        t = clamp(t, 0.0, 1.0);
        vec3 c0 = vec3(0.05, 0.08, 0.12); // deep ocean / no clouds
        vec3 c1 = vec3(0.6, 0.8, 0.9);    // low warm clouds
        vec3 c2 = vec3(0.1, 0.3, 0.9);    // mid cold clouds
        vec3 c3 = vec3(0.0, 0.8, 0.2);    // deep convection (green)
        vec3 c4 = vec3(1.0, 0.8, 0.0);    // intense (yellow)
        vec3 c5 = vec3(1.0, 0.0, 0.0);    // severe (red)
        vec3 c6 = vec3(0.1, 0.0, 0.0);    // overshooting tops (dark red/blackish)
        vec3 c7 = vec3(1.0, 1.0, 1.0);    // absolute coldest tops (white)

        vec3 color = c0;
        color = mix(color, c1, smoothstep(0.0, 0.2, t));
        color = mix(color, c2, smoothstep(0.2, 0.3, t));
        color = mix(color, c3, smoothstep(0.3, 0.5, t));
        color = mix(color, c4, smoothstep(0.5, 0.7, t));
        color = mix(color, c5, smoothstep(0.7, 0.85, t));
        color = mix(color, c6, smoothstep(0.85, 0.95, t));
        color = mix(color, c7, smoothstep(0.95, 1.0, t));
        return color;
    }

    void main() {
        vec2 uv = 0.7 * (2.0 * gl_FragCoord.xy - u_resolution.xy) / u_resolution.y;
        float dist = length(uv);
        float angle = atan(uv.y, uv.x);

        // asymmetric geometry
        float angle_diff = angle - u_asym_dir;
        float asym_factor = cos(angle_diff);

        float radius_multiplier = max(0.3, 1.0 + asym_factor * u_asym_strength);
        float dynamic_storm_radius = u_storm_radius * radius_multiplier;
        float total_distortion_amplitude = 0.01 + u_wind_shear_strength * 0.9;

        // spiral cloud bands
        float spiral_angle = angle + u_spiral_strength * log(dist) * u_hemisphere - u_time * 0.3 * u_hemisphere;

        // convective "boiling" effect added to time
        vec2 noise_uv = vec2(cos(spiral_angle) * dist, sin(spiral_angle) * dist) * 4.0;
        noise_uv.y += u_time * 0.15;
        noise_uv.x += fbm(noise_uv + u_time * 0.05) * 0.5; // micro-turbulence

        float noise_val = fbm(noise_uv + u_random_seed);
        // density asymmetry (thicker clouds on the extended shear side)
        noise_val += smoothstep(-0.5, 1.0, asym_factor) * u_asym_strength * 0.2;

        // eye and eyewall
        vec2 spiral_boundary_noise_uv = uv * 6.0 + u_time * 0.4;
        float spiral_inner_radius = (u_eye_radius - u_wind_shear_strength) + (fbm(spiral_boundary_noise_uv) * total_distortion_amplitude);

        // dynamic eye sharpness (so sharper eye for stronger storms where u_eye_radius is positive)
        float eye_falloff = smoothstep(spiral_inner_radius, spiral_inner_radius + max(0.02, 0.15 - (u_eye_radius * 2.0)), dist);
        noise_val *= eye_falloff;

        float storm_falloff = smoothstep(dynamic_storm_radius + 0.2, dynamic_storm_radius, dist - fbm(uv * 1.5 + u_time * 0.05) * u_shape_distortion);
        noise_val *= storm_falloff;

        // central dense overcast (CDO)
        float central_mass_value = 0.0;
        if (u_central_mass_size > 0.0) {
            vec2 cdo_uv = uv - vec2(0.707106, 0.707106) * u_wind_shear_strength;
            float cdo_dist = length(cdo_uv);
            float central_mass_outer_radius = u_eye_radius + u_central_mass_size;

            if (cdo_dist < central_mass_outer_radius + total_distortion_amplitude + 0.2) {
                float cdo_angle = atan(cdo_uv.y, cdo_uv.x);
                float boundary_perturbation = fbm(cdo_uv * 6.0 + u_time * 0.3) * total_distortion_amplitude;

                float perturbed_inner_radius = (u_eye_radius - u_wind_shear_strength) + boundary_perturbation;
                float perturbed_outer_radius = central_mass_outer_radius + boundary_perturbation;

                float central_mass_shape = smoothstep(perturbed_inner_radius, perturbed_inner_radius + 0.06, cdo_dist)
                                         * smoothstep(perturbed_outer_radius + 0.15, perturbed_outer_radius, cdo_dist);

                float central_mass_internal_angle = cdo_angle + u_spiral_strength * log(cdo_dist) * u_hemisphere - u_time * 0.36 * u_hemisphere - u_wind_shear_strength;

                vec2 central_mass_internal_noise_coords = vec2(
                    cos(central_mass_internal_angle) * cdo_dist - u_wind_shear_strength,
                    sin(central_mass_internal_angle) * cdo_dist - u_wind_shear_strength
                );

                central_mass_value = central_mass_shape * (0.85 + fbm(central_mass_internal_noise_coords * 6.0) * 0.15);
            }
        }

        noise_val = max(noise_val, central_mass_value);
        float cloud_intensity = smoothstep(u_cloud_low, u_cloud_high, noise_val);

        // output mixing
        vec3 color = nrl_color_ramp(cloud_intensity);
        float ir_val = max(0.1, pow(cloud_intensity * 1.3, 1.2));

        gl_FragColor = vec4(mix(color, vec3(ir_val), u_grayscale), 1.0);
    }
`;

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

// current visual state parameters
let currentParams = {
    spiral: 1.0, eye: -0.1, distortion: 0.4, stormRadius: 0.2,
    centralMass: 0.0, shear: 0.0, cloudLow: 0.1, cloudHigh: 0.8,
    hemisphere: 1.0, // 1.0 for Northern Hem, -1.0 for Southern
    seed: Math.random() * 100,
    asymStrength: 0.0,
    asymDir: 0.0
};

export function resetSatelliteParams() {
    currentParams = {
        spiral: 1.0,
        eye: -0.1,
        distortion: Math.random() * 0.4,
        stormRadius: Math.random() * 0.2 + 0.1,
        centralMass: Math.random() * 0.2,
        shear: Math.random() * 0.1,
        cloudLow: 0.0,
        cloudHigh: Math.random() * 0.5 + 0.5,
        hemisphere: 1.0,
        seed: Math.random() * 100,
        asymStrength: Math.random() * 0.3,
        asymDir: Math.random() * 6.28
    };
}

function lerp(start, end, t) {
    return start * (1 - t) + end * t;
}

function oscillate(base, amplitude, speed) {
    return base + Math.sin(performance.now() * 0.001 * speed) * amplitude;
}

const targetParams = {
    spiral: 1.0, eye: -0.1, distortion: 0.4, stormRadius: 0.2,
    centralMass: 0.0, shear: 0.0, cloudLow: 0.1, cloudHigh: 0.8,
    asymStrength: 0.0, asymDir: 0.0
};

export function initSatelliteView(canvasId) {
    canvas = document.getElementById(canvasId);
    if (!canvas) return;

    gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return;

    const vShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vShader || !fShader) return;

    program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Program link error:", gl.getProgramInfoLog(program));
        return;
    }

    // cache uniforms
    const uniformNames = [
        "u_resolution", "u_time", "u_spiral_strength", "u_eye_radius",
        "u_shape_distortion", "u_storm_radius", "u_central_mass_size",
        "u_wind_shear_strength", "u_cloud_low", "u_cloud_high", "u_random_seed",
        "u_hemisphere", "u_asym_strength", "u_asym_dir", "u_grayscale"
    ];
    uniformNames.forEach(name => {
        uniforms[name] = gl.getUniformLocation(program, name);
    });

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const positionAttrib = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(positionAttrib);
    gl.vertexAttribPointer(positionAttrib, 2, gl.FLOAT, false, 0, 0);

    startTime = Date.now();
    requestAnimationFrame(render);
}

export function setSatelliteGrayscale(enable) {
    isGrayscale = enable;
}

// dynamically updates the shader inputs based on storm telemetry
export function updateSatelliteView(intensityKnots, age, latitude, isExtratropical, isSubtropical, isLand = false, sst = 29, humidity = 75) {
    if (intensityKnots == null || isNaN(intensityKnots)) intensityKnots = 0;
    if (latitude == null || isNaN(latitude)) latitude = 0;
    if (sst == null || isNaN(sst)) sst = 29;
    if (humidity == null || isNaN(humidity)) humidity = 75;

    currentParams.hemisphere = latitude < 0 ? -1.0 : 1.0;

    // base target parameters
    targetParams.spiral = 1.0; targetParams.eye = -0.1; targetParams.distortion = 0.4;
    targetParams.stormRadius = 0.2; targetParams.centralMass = 0.0; targetParams.shear = 0.0;
    targetParams.cloudLow = 0.1; targetParams.cloudHigh = 0.8;
    targetParams.asymStrength = 0.0; targetParams.asymDir = 0.0;

    let randomFactor = Math.random();
    let dynamicAsymStr = oscillate(0.25, 0.55, 0.5);
    let dynamicAsymDir = (performance.now() * 0.0002) % 6.28;

    // continuous intensity modifier (scales 0.0 to 1.0 between TS and Cat 5)
    let powerScale = Math.max(0, Math.min(1, (intensityKnots - 34) * 0.008333)); // 1/120

    // ============================================================
    // structural morphology (spiral, eye, distortion)
    // ============================================================
    if (isExtratropical) {
        // comma-shape baroclinic leaf structure
        targetParams.spiral = 0.8; targetParams.eye = -0.2; targetParams.distortion = 0.6; targetParams.stormRadius = 0.4;
        targetParams.centralMass = 0.0; targetParams.shear = 0.2; targetParams.asymStrength = 1.5; targetParams.asymDir = 5.5;
    } else if (isSubtropical) {
        // broad, somewhat asymmetric structure
        targetParams.spiral = 1.0; targetParams.eye = -0.15; targetParams.distortion = 0.5; targetParams.stormRadius = 0.3;
        targetParams.centralMass = 0.05; targetParams.shear = 0.15; targetParams.asymStrength = 0.5; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 24) { // low pressure area
        targetParams.spiral = 0.5; targetParams.eye = -0.10; targetParams.distortion = Math.random() * 0.3 + 0.1;
        targetParams.stormRadius = 0.1; targetParams.centralMass = 0.0; targetParams.shear = 0.10;
        targetParams.asymStrength = dynamicAsymStr * 1.5; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 34) { // tropical depression
        targetParams.spiral = 1.0; targetParams.eye = -0.10; targetParams.distortion = 0.4; targetParams.stormRadius = 0.15;
        targetParams.centralMass = 0.0; targetParams.shear = 0.10; targetParams.asymStrength = dynamicAsymStr * 1.4; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 64) { // tropical storm
        targetParams.spiral = 1.2 + (powerScale * 0.2);
        targetParams.eye = -0.06; targetParams.distortion = 0.35; targetParams.stormRadius = 0.25;
        targetParams.centralMass = randomFactor * 0.30; targetParams.shear = randomFactor * 0.20;
        targetParams.asymStrength = dynamicAsymStr * 1.3; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 83) { // Cat 1
        targetParams.spiral = 1.4; targetParams.eye = oscillate(0.0, 0.025, 1.0); targetParams.distortion = 0.30;
        targetParams.stormRadius = 0.2; targetParams.centralMass = currentParams.seed > 50 ? 0.15 : -0.05;
        targetParams.shear = currentParams.seed > 50 ? 0.08 : 0.0;
        targetParams.asymStrength = dynamicAsymStr * 1.2; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 96) { // Cat 2
        targetParams.spiral = 1.6; targetParams.eye = oscillate(0.01, 0.025, 1.5); targetParams.distortion = 0.35;
        targetParams.stormRadius = 0.22; targetParams.centralMass = 0.12; targetParams.shear = 0.04;
        targetParams.asymStrength = dynamicAsymStr * 1.1; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 113) { // Cat 3
        targetParams.spiral = 1.9; targetParams.eye = oscillate(0.02, 0.025, 2.0); targetParams.distortion = Math.random() * 0.05 + 0.27;
        targetParams.stormRadius = Math.random() * 0.05 + 0.27; targetParams.centralMass = 0.10; targetParams.shear = 0.03;
        targetParams.asymStrength = dynamicAsymStr * 1.0; targetParams.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 137) { // Cat 4
        // eye begins to clear out and stabilize
        targetParams.spiral = 2.0 + (powerScale * 0.2); targetParams.eye = oscillate(0.03, 0.02, 2.5); targetParams.distortion = Math.random() * 0.30;
        targetParams.stormRadius = 0.25; targetParams.centralMass = 0.08; targetParams.shear = 0.02;
        targetParams.asymStrength = dynamicAsymStr * 0.8; targetParams.asymDir = dynamicAsymDir;
    } else { // Cat 5
        // pin-hole eye, highly symmetric, deep convection
        targetParams.spiral = 2.5; targetParams.eye = oscillate(0.04, 0.015, 3.0); targetParams.distortion = Math.random() * 0.20;
        targetParams.stormRadius = 0.20; targetParams.centralMass = Math.random() * 0.05 + 0.05; targetParams.shear = 0.00;
        targetParams.asymStrength = dynamicAsymStr * 0.5; targetParams.asymDir = dynamicAsymDir;
    }

    // ============================================================
    // cloud density mapping (humidity & SST driven)
    // ============================================================

    const isMatureTropical = !isExtratropical && !isSubtropical && intensityKnots >= 34;

    if (!isMatureTropical) {

        // weaker or transitioning systems are looser and more diffuse
        if (isExtratropical) targetParams.cloudHigh = 2.0;
        else if (isSubtropical) targetParams.cloudHigh = 1.6;
        else if (intensityKnots < 24) targetParams.cloudHigh = 1.3;
        else targetParams.cloudHigh = 1.1;

        if (humidity < 60) targetParams.cloudHigh += 0.2; // dry air thins clouds
    } else {
        // mature tropical systems map cloud density strictly to environmental moisture
        // 95% Hum -> CloudHigh 0.45 (thick, white CDO)
        // 40% Hum -> CloudHigh 1.35 (thin, dissipating)
        const effectiveHum = Math.max(30, Math.min(98, humidity));
        targetParams.cloudHigh = 2.1 - (effectiveHum * 0.015);
    }

    // environmental jitter and adjustments
    let jitter = (Math.random() - 0.5) * 0.02;
    targetParams.stormRadius += jitter;
    targetParams.distortion += jitter * 2.0;

    let sstEffect = Math.max(0, (27.0 - sst) * 0.3); // colder water thins clouds
    targetParams.cloudHigh += sstEffect;

    const smoothFactor = 0.25;

    // landfall structural degradation
    if (isLand) {
        currentParams.cloudHigh += 0.15;
        currentParams.centralMass -= 0.04;
        if (currentParams.cloudHigh > 2.0) currentParams.cloudHigh = 2.0;

        targetParams.eye = -0.15; // eye fills with clouds
        targetParams.spiral *= 0.8;
    } else {
        currentParams.cloudHigh = lerp(currentParams.cloudHigh, targetParams.cloudHigh, smoothFactor);
    }

    // apply linear interpolation for smooth visual transitions

    currentParams.spiral = lerp(currentParams.spiral, targetParams.spiral, smoothFactor);
    currentParams.eye = lerp(currentParams.eye, targetParams.eye, smoothFactor);
    currentParams.distortion = lerp(currentParams.distortion, targetParams.distortion, smoothFactor);
    currentParams.stormRadius = lerp(currentParams.stormRadius, targetParams.stormRadius, smoothFactor);
    currentParams.centralMass = lerp(currentParams.centralMass, targetParams.centralMass, smoothFactor);
    currentParams.shear = lerp(currentParams.shear, targetParams.shear, smoothFactor);
    currentParams.cloudLow = lerp(currentParams.cloudLow, targetParams.cloudLow, smoothFactor);
    currentParams.asymStrength = lerp(currentParams.asymStrength, targetParams.asymStrength, smoothFactor);
    currentParams.asymDir = lerp(currentParams.asymDir, targetParams.asymDir, smoothFactor * 0.5);
}

const glCache = {};

function render() {
    if (!gl || !program) return;

    if (canvas.clientWidth === 0 && canvas.clientHeight === 0) {
        requestAnimationFrame(render);
        return;
    }

    const time = performance.now() * 0.001;
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    gl.useProgram(program);

    if (glCache.width !== canvas.width || glCache.height !== canvas.height) {
        gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);
        glCache.width = canvas.width;
        glCache.height = canvas.height;
    }

    gl.uniform1f(uniforms.u_time, time);

    const p = currentParams;

    // only update GPU if parameters actually changed since the last frame
    if (glCache.spiral !== p.spiral) { gl.uniform1f(uniforms.u_spiral_strength, p.spiral); glCache.spiral = p.spiral; }
    if (glCache.eye !== p.eye) { gl.uniform1f(uniforms.u_eye_radius, p.eye); glCache.eye = p.eye; }
    if (glCache.distortion !== p.distortion) { gl.uniform1f(uniforms.u_shape_distortion, p.distortion); glCache.distortion = p.distortion; }
    if (glCache.stormRadius !== p.stormRadius) { gl.uniform1f(uniforms.u_storm_radius, p.stormRadius); glCache.stormRadius = p.stormRadius; }
    if (glCache.centralMass !== p.centralMass) { gl.uniform1f(uniforms.u_central_mass_size, p.centralMass); glCache.centralMass = p.centralMass; }
    if (glCache.shear !== p.shear) { gl.uniform1f(uniforms.u_wind_shear_strength, p.shear); glCache.shear = p.shear; }
    if (glCache.cloudLow !== p.cloudLow) { gl.uniform1f(uniforms.u_cloud_low, p.cloudLow); glCache.cloudLow = p.cloudLow; }
    if (glCache.cloudHigh !== p.cloudHigh) { gl.uniform1f(uniforms.u_cloud_high, p.cloudHigh); glCache.cloudHigh = p.cloudHigh; }
    if (glCache.seed !== p.seed) { gl.uniform1f(uniforms.u_random_seed, p.seed); glCache.seed = p.seed; }
    if (glCache.hemisphere !== p.hemisphere) { gl.uniform1f(uniforms.u_hemisphere, p.hemisphere); glCache.hemisphere = p.hemisphere; }
    if (glCache.asymStrength !== p.asymStrength) { gl.uniform1f(uniforms.u_asym_strength, p.asymStrength); glCache.asymStrength = p.asymStrength; }
    if (glCache.asymDir !== p.asymDir) { gl.uniform1f(uniforms.u_asym_dir, p.asymDir); glCache.asymDir = p.asymDir; }

    const grayVal = isGrayscale ? 1.0 : 0.0;
    if (glCache.grayscale !== grayVal) { gl.uniform1f(uniforms.u_grayscale, grayVal); glCache.grayscale = grayVal; }

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
}

export function getSatelliteSnapshot() {
    if (!gl || !canvas || !program) return null;

    // force a render tick to guarantee up-to-date visual state
    render();
    return canvas.toDataURL('image/png');
}
