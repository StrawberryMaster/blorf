/**
 * js/satellite-view.js
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

    float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    float noise(vec2 st) {
        vec2 i = floor(st);
        vec2 f = fract(st);
        float a = random(i);
        float b = random(i + vec2(1.0, 0.0));
        float c = random(i + vec2(0.0, 1.0));
        float d = random(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.y * u.x;
    }

    #define FBM_OCTAVES 5
    float fbm(vec2 st) {
        float value = 0.0;
        float amplitude = 0.6;
        float max_amplitude = 0.0;
        for (int i = 0; i < FBM_OCTAVES; i++) {
            value += amplitude * noise(st);
            max_amplitude += amplitude;
            st *= 2.0;
            amplitude *= 0.5;
        }
        return (value / max_amplitude) * 0.9999;
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

        float radius_multiplier = 1.0 + asym_factor * u_asym_strength;
        radius_multiplier = max(0.3, radius_multiplier);

        float dynamic_storm_radius = u_storm_radius * radius_multiplier;

        float base_distortion_amp = 0.01;
        float shear_distortion_factor = 0.9;
        float total_distortion_amplitude = base_distortion_amp + u_wind_shear_strength * shear_distortion_factor;

        float ROTATION_SPEED = 0.3;
        float NOISE_SCALE = 4.0;

        // spiral cloud bands
        float spiral_angle = angle + u_spiral_strength * log(dist) * u_hemisphere - u_time * ROTATION_SPEED * u_hemisphere;

        // convective "boiling" effect added to time
        vec2 noise_uv = vec2(cos(spiral_angle) * dist, sin(spiral_angle) * dist) * NOISE_SCALE;
        noise_uv.y += u_time * 0.15;
        noise_uv.x += fbm(noise_uv + u_time * 0.05) * 0.5; // micro-turbulence

        float noise_val = fbm(noise_uv + u_random_seed);

        // density asymmetry (thicker clouds on the extended shear side)
        float density_boost = smoothstep(-0.5, 1.0, asym_factor) * u_asym_strength * 0.2;
        noise_val += density_boost;

        // eye and eyewall
        vec2 spiral_boundary_noise_uv = uv * 6.0 + u_time * 0.4;
        float spiral_boundary_perturbation = fbm(spiral_boundary_noise_uv) * total_distortion_amplitude;

        float spiral_inner_radius = (u_eye_radius - u_wind_shear_strength) + spiral_boundary_perturbation;

        // dynamic eye sharpness (so sharper eye for stronger storms where u_eye_radius is positive)
        float eye_softness = max(0.02, 0.15 - (u_eye_radius * 2.0));
        float spiral_inner_radius_soft = spiral_inner_radius + eye_softness;

        float eye_falloff = smoothstep(spiral_inner_radius, spiral_inner_radius_soft, dist);
        noise_val *= eye_falloff;

        float distortion_noise = fbm(uv * 1.5 + u_time * 0.05);
        float distorted_dist = dist - distortion_noise * u_shape_distortion;

        float storm_falloff = 1.0 - smoothstep(dynamic_storm_radius, dynamic_storm_radius + 0.2, distorted_dist);
        noise_val *= storm_falloff;

        // central dense overcast (CDO)
        float central_mass_value = 0.0;
        if (u_central_mass_size > 0.0) {
            vec2 shear_direction = normalize(vec2(1.0, 1.0));
            vec2 cdo_uv = uv - shear_direction * u_wind_shear_strength;
            float cdo_dist = length(cdo_uv);
            float cdo_angle = atan(cdo_uv.y, cdo_uv.x);

            float central_mass_outer_radius = u_eye_radius + u_central_mass_size;
            vec2 boundary_noise_uv = cdo_uv * 6.0 + u_time * 0.3;
            float boundary_perturbation = fbm(boundary_noise_uv) * total_distortion_amplitude;

            float perturbed_inner_radius = (u_eye_radius - u_wind_shear_strength) + boundary_perturbation;
            float perturbed_outer_radius = central_mass_outer_radius + boundary_perturbation;

            float central_mass_shape = smoothstep(perturbed_inner_radius, perturbed_inner_radius + 0.06, cdo_dist)
                                     * (1.0 - smoothstep(perturbed_outer_radius, perturbed_outer_radius + 0.15, cdo_dist));

            float central_mass_rotation_speed = ROTATION_SPEED * 1.2;

            float central_mass_internal_angle = cdo_angle + u_spiral_strength * log(cdo_dist) * u_hemisphere
                                              - u_time * central_mass_rotation_speed * u_hemisphere
                                              - u_wind_shear_strength;

            vec2 central_mass_internal_noise_coords;
            central_mass_internal_noise_coords.x = cos(central_mass_internal_angle) * cdo_dist - u_wind_shear_strength;
            central_mass_internal_noise_coords.y = sin(central_mass_internal_angle) * cdo_dist - u_wind_shear_strength;

            float internal_texture = fbm(central_mass_internal_noise_coords * 6.0);
            central_mass_value = central_mass_shape * (0.85 + internal_texture * 0.15);
        }

        noise_val = max(noise_val, central_mass_value);
        float cloud_intensity = smoothstep(u_cloud_low, u_cloud_high, noise_val);

        // output mixing
        vec3 color = nrl_color_ramp(cloud_intensity);
        float ir_val = max(0.1, pow(cloud_intensity * 1.3, 1.2));
        vec3 grayColor = vec3(ir_val);
        vec3 final_color = mix(color, grayColor, u_grayscale);

        gl_FragColor = vec4(final_color, 1.0);
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
    return base + Math.sin(Date.now() * 0.001 * speed) * amplitude;
}

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
    let target = {
        spiral: 1.0, eye: -0.1, distortion: 0.4, stormRadius: 0.2,
        centralMass: 0.0, shear: 0.0, cloudLow: 0.1, cloudHigh: 0.8,
        asymStrength: 0.0, asymDir: 0.0
    };

    let randomFactor = Math.random();
    let dynamicAsymStr = oscillate(0.25, 0.55, 0.5);
    let dynamicAsymDir = (Date.now() * 0.0002) % 6.28;

    // continuous intensity modifier (scales 0.0 to 1.0 between TS and Cat 5)
    let powerScale = Math.max(0, Math.min(1, (intensityKnots - 34) / 120));

    // ============================================================
    // structural morphology (spiral, eye, distortion)
    // ============================================================
    if (isExtratropical) {
        // comma-shape baroclinic leaf structure
        target.spiral = 0.8; target.eye = -0.2; target.distortion = 0.6; target.stormRadius = 0.4;
        target.centralMass = 0.0; target.shear = 0.2; target.asymStrength = 1.5; target.asymDir = 5.5;
    } else if (isSubtropical) {
        // broad, somewhat asymmetric structure
        target.spiral = 1.0; target.eye = -0.15; target.distortion = 0.5; target.stormRadius = 0.3;
        target.centralMass = 0.05; target.shear = 0.15; target.asymStrength = 0.5; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 24) { // low pressure area
        target.spiral = 0.5; target.eye = -0.10; target.distortion = Math.random() * 0.3 + 0.1;
        target.stormRadius = 0.1; target.centralMass = 0.0; target.shear = 0.10;
        target.asymStrength = dynamicAsymStr * 1.5; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 34) { // tropical depression
        target.spiral = 1.0; target.eye = -0.10; target.distortion = 0.4; target.stormRadius = 0.15;
        target.centralMass = 0.0; target.shear = 0.10; target.asymStrength = dynamicAsymStr * 1.4; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 64) { // tropical storm
        target.spiral = 1.2 + (powerScale * 0.2);
        target.eye = -0.06; target.distortion = 0.35; target.stormRadius = 0.25;
        target.centralMass = randomFactor * 0.30; target.shear = randomFactor * 0.20;
        target.asymStrength = dynamicAsymStr * 1.3; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 83) { // Cat 1
        target.spiral = 1.4; target.eye = oscillate(0.0, 0.025, 1.0); target.distortion = 0.30;
        target.stormRadius = 0.2; target.centralMass = currentParams.seed > 50 ? 0.15 : -0.05;
        target.shear = currentParams.seed > 50 ? 0.08 : 0.0;
        target.asymStrength = dynamicAsymStr * 1.2; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 96) { // Cat 2
        target.spiral = 1.6; target.eye = oscillate(0.01, 0.025, 1.5); target.distortion = 0.35;
        target.stormRadius = 0.22; target.centralMass = 0.12; target.shear = 0.04;
        target.asymStrength = dynamicAsymStr * 1.1; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 113) { // Cat 3
        target.spiral = 1.9; target.eye = oscillate(0.02, 0.025, 2.0); target.distortion = Math.random() * 0.05 + 0.27;
        target.stormRadius = Math.random() * 0.05 + 0.27; target.centralMass = 0.10; target.shear = 0.03;
        target.asymStrength = dynamicAsymStr * 1.0; target.asymDir = dynamicAsymDir;
    } else if (intensityKnots < 137) { // Cat 4
        // eye begins to clear out and stabilize
        target.spiral = 2.0 + (powerScale * 0.2); target.eye = oscillate(0.03, 0.02, 2.5); target.distortion = Math.random() * 0.30;
        target.stormRadius = 0.25; target.centralMass = 0.08; target.shear = 0.02;
        target.asymStrength = dynamicAsymStr * 0.8; target.asymDir = dynamicAsymDir;
    } else { // Cat 5
        // pin-hole eye, highly symmetric, deep convection
        target.spiral = 2.5; target.eye = oscillate(0.04, 0.015, 3.0); target.distortion = Math.random() * 0.20;
        target.stormRadius = 0.20; target.centralMass = Math.random() * 0.05 + 0.05; target.shear = 0.00;
        target.asymStrength = dynamicAsymStr * 0.5; target.asymDir = dynamicAsymDir;
    }

    // ============================================================
    // cloud density mapping (humidity & SST driven)
    // ============================================================

    const isMatureTropical = !isExtratropical && !isSubtropical && intensityKnots >= 34;

    if (!isMatureTropical) {
        // weaker or transitioning systems are looser and more diffuse
        if (isExtratropical) target.cloudHigh = 2.0;
        else if (isSubtropical) target.cloudHigh = 1.6;
        else if (intensityKnots < 24) target.cloudHigh = 1.3;
        else target.cloudHigh = 1.1;

        if (humidity < 60) target.cloudHigh += 0.2; // dry air thins clouds
    } else {
        // mature tropical systems map cloud density strictly to environmental moisture
        // 95% Hum -> CloudHigh 0.45 (thick, white CDO)
        // 40% Hum -> CloudHigh 1.35 (thin, dissipating)
        const effectiveHum = Math.max(30, Math.min(98, humidity));
        target.cloudHigh = 2.1 - (effectiveHum * 0.015);
    }

    // environmental jitter and adjustments
    let jitter = (Math.random() - 0.5) * 0.02;
    target.stormRadius += jitter;
    target.distortion += jitter * 2.0;

    let sstThreshold = 27.0;
    let sstEffect = Math.max(0, (sstThreshold - sst) * 0.3); // Colder water thins clouds
    target.cloudHigh += sstEffect;

    const smoothFactor = 0.25;

    // landfall structural degradation
    if (isLand) {
        currentParams.cloudHigh += 0.15;
        currentParams.centralMass -= 0.04;
        if (currentParams.cloudHigh > 2.0) currentParams.cloudHigh = 2.0;

        target.eye = -0.15; // eye fills with clouds
        target.spiral *= 0.8;
    } else {
        currentParams.cloudHigh = lerp(currentParams.cloudHigh, target.cloudHigh, smoothFactor);
    }

    // apply linear interpolation for smooth visual transitions
    currentParams.spiral = lerp(currentParams.spiral, target.spiral, smoothFactor);
    currentParams.eye = lerp(currentParams.eye, target.eye, smoothFactor);
    currentParams.distortion = lerp(currentParams.distortion, target.distortion, smoothFactor);
    currentParams.stormRadius = lerp(currentParams.stormRadius, target.stormRadius, smoothFactor);
    currentParams.centralMass = lerp(currentParams.centralMass, target.centralMass, smoothFactor);
    currentParams.shear = lerp(currentParams.shear, target.shear, smoothFactor);
    currentParams.cloudLow = lerp(currentParams.cloudLow, target.cloudLow, smoothFactor);
    currentParams.asymStrength = lerp(currentParams.asymStrength, target.asymStrength, smoothFactor);
    currentParams.asymDir = lerp(currentParams.asymDir, target.asymDir, smoothFactor * 0.5);
}

function render() {
    if (!gl || !program) return;

    const time = (Date.now() - startTime) * 0.001;

    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
    }

    gl.useProgram(program);

    gl.uniform2f(uniforms.u_resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.u_time, time);
    gl.uniform1f(uniforms.u_spiral_strength, currentParams.spiral);
    gl.uniform1f(uniforms.u_eye_radius, currentParams.eye);
    gl.uniform1f(uniforms.u_shape_distortion, currentParams.distortion);
    gl.uniform1f(uniforms.u_storm_radius, currentParams.stormRadius);
    gl.uniform1f(uniforms.u_central_mass_size, currentParams.centralMass);
    gl.uniform1f(uniforms.u_wind_shear_strength, currentParams.shear);
    gl.uniform1f(uniforms.u_cloud_low, currentParams.cloudLow);
    gl.uniform1f(uniforms.u_cloud_high, currentParams.cloudHigh);
    gl.uniform1f(uniforms.u_random_seed, currentParams.seed);
    gl.uniform1f(uniforms.u_hemisphere, currentParams.hemisphere);
    gl.uniform1f(uniforms.u_asym_strength, currentParams.asymStrength);
    gl.uniform1f(uniforms.u_asym_dir, currentParams.asymDir);
    gl.uniform1f(uniforms.u_grayscale, isGrayscale ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(render);
}

export function getSatelliteSnapshot() {
    if (!gl || !canvas || !program) return null;

    // force a render tick to guarantee up-to-date visual state
    render();
    return canvas.toDataURL('image/png');
}
