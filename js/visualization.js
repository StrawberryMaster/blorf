/**
 * visualization.js
 * Contains all D3.js rendering functions and canvas drawing tools.
 */
import { getCategory, getPressureAt, windToPressure, directionToCompass, createGeoCircle, unwrapLongitude, calculateHollandPressure, getSST, calculateDistance } from './utils.js';
import { getWindVectorAt } from './cyclone-model.js';
import { generatePathForecasts } from './forecast-models.js';
import { getElevationAt, getLandStatus } from './terrain-data.js';

// simple pseudo-random noise function (for macro-scale humidity fluctuations)
function pseudoNoise(x, y) {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
}

// smoothed noise via bilinear interpolation
export function smoothNoise(x, y) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const u = x - i;
    const v = y - j;

    // smoothstep interpolation formula
    const uSm = u * u * (3 - 2 * u);
    const vSm = v * v * (3 - 2 * v);

    const n00 = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    const p00 = n00 - Math.floor(n00);

    const n10 = Math.sin((i + 1) * 12.9898 + j * 78.233) * 43758.5453;
    const p10 = n10 - Math.floor(n10);

    const n01 = Math.sin(i * 12.9898 + (j + 1) * 78.233) * 43758.5453;
    const p01 = n01 - Math.floor(n01);

    const n11 = Math.sin((i + 1) * 12.9898 + (j + 1) * 78.233) * 43758.5453;
    const p11 = n11 - Math.floor(n11);

    const x1 = p00 + (p10 - p00) * uSm;
    const x2 = p01 + (p11 - p01) * uSm;

    return x1 + (x2 - x1) * vSm;
}

// calculates background humidity for a given point (excludes cyclone core moisture)
export function calculateBackgroundHumidity(lon, lat, pressureSystems, currentMonth, cyclone = null, globalTemp = 289) {
    const bgTemp = globalTemp;

    // base inverse logic: lower pressure -> higher humidity
    const p = getPressureAt(lon, lat, pressureSystems);
    let hum = 83 + (1010 - p) * 1.3 + 3 * (bgTemp - 289);

    // perlin noise overlay (macro-scale moisture transport)
    const timeFactor = (cyclone && cyclone.age) ? cyclone.age * 0.02 : 0;
    const scale = 0.06;
    const noise = smoothNoise(lon * scale + timeFactor, lat * scale);
    hum += (noise - 0.5) * 35;

    // latitude correction (wet equator, dry poles)
    const latRad = lat * Math.PI / 180;
    hum *= (0.6 + 0.4 * Math.cos(latRad));

    const isNorth = lat > 0;
    let baseDryLat = isNorth ? 46 : -46;
    const systemsList = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems?.lower || []);

    if (systemsList.length > 0) {
        const subpolarLow = systemsList.find(s =>
            s.baseSigmaX > 200 && s.strength < -15 && (isNorth ? s.y > 30 : s.y < -30)
        );
        if (subpolarLow) {
            baseDryLat = subpolarLow.y + (isNorth ? 5 : -8);
        }
    }

    // Rossby wave shift calculation
    const waveNumber = 5.0;
    const phaseSpeed = (cyclone ? cyclone.age : 0) * 0.02;
    const waveAmplitude = 6.0;
    const rossbyOffset = Math.sin((lon * Math.PI / 180) * waveNumber + phaseSpeed) * waveAmplitude;

    // jet stream turbulence overlay
    const jetNoise = (smoothNoise(lon * 0.08, timeFactor) - 0.5) * 8.0;

    // combine target dry latitude
    const targetDryLat = baseDryLat + rossbyOffset + jetNoise;

    // apply Gaussian distribution reduction for Westerlies dry band
    const dryBandWidth = 200;
    const westerliesDryFactor = Math.exp(-Math.pow(lat - targetDryLat, 2) / dryBandWidth);
    hum -= westerliesDryFactor * 100;

    // topography & Foehn effect
    const elevation = getElevationAt(lon, lat);
    if (elevation > 0) hum -= (elevation / 200) * 15;

    // Foehn effect trail backtracking
    if (cyclone) {
        const vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems);
        const len = Math.sqrt(vec.u * vec.u + vec.v * vec.v);

        let windWeight = Math.max(0, Math.min(1, (len - 15.0) / 15.0));

        if (windWeight > 0.01) {
            const dirU = vec.u / len;
            const dirV = vec.v / len;
            const traceSteps = 30;
            const stepSize = 0.1;
            const decayFactor = 0.2;
            let maxDryImpact = 0;

            for (let i = 1; i <= traceSteps; i++) {
                const dist = i * stepSize;
                const upLon = lon - (dirU * dist);
                const upLat = lat - (dirV * dist);
                const upElevation = getElevationAt(upLon, upLat);
                const elevationDiff = upElevation - elevation;

                if (elevationDiff > 30) {
                    let impact = (elevationDiff / 30) * (vec.magnitude - 22) * Math.exp(-dist * decayFactor);
                    if (impact > maxDryImpact) maxDryImpact = impact;
                }
            }

            hum -= Math.min(maxDryImpact, 80);
        }
    }

    return Math.max(5, Math.min(100, hum));
}

export function calculateTotalHumidity(lon, lat, pressureSystems, cyclone, globalTemp) {
    const currentMonth = (cyclone && cyclone.currentMonth) ? cyclone.currentMonth : 8;
    let hum = calculateBackgroundHumidity(lon, lat, pressureSystems, currentMonth, cyclone, globalTemp);

    if (cyclone && cyclone.status === 'active') {
        const dx = lon - cyclone.lon;
        const dy = lat - cyclone.lat;
        const dist = Math.sqrt(dx*dx + dy*dy);

        // Central Dense Overcast (CDO) moisture boost
        if (dist < cyclone.circulationSize * 0.01) {
            hum += Math.max(0, 50 * (1 - dist/(cyclone.circulationSize * 0.01)));
        }

        // spiral rainbands
        if (dist < cyclone.circulationSize * 0.02) {
            const angle = Math.atan2(dy, dx);
            const spiral = Math.sin(angle * 3 + dist * 2 - (cyclone.age || 0) * 0.1);
            if (spiral > 0.5) hum += 10;
        }
    }

    return Math.max(10, Math.min(99, hum));
}

export function drawHumidityField(container, mapProjection, pressureSystems, cyclone, globalTemp) {
    const svgNode = container.node().closest('svg');
    const { width, height } = svgNode.getBoundingClientRect();

    const nx = 56, ny = Math.round(nx * height / width);

    const grid = new Float32Array(nx * ny);

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) {
                grid[j * nx + i] = 0;
                continue;
            }
            grid[j * nx + i] = calculateTotalHumidity(coords[0], coords[1], pressureSystems, cyclone, globalTemp);
        }
    }

    const contours = d3.contours().size([nx, ny]).thresholds([10,20,30,40,50,60,70,80,90]);
    const transform = d3.geoTransform({ point: function(x, y) { this.stream.point(x * width / nx, y * height / ny); } });
    const pathGenerator = d3.geoPath().projection(transform);

    container.selectAll("path")
        .data(contours(grid))
        .enter().append("path")
        .attr("d", pathGenerator)
        .attr("class", d => {
            if (d.value >= 90) return "isohume-high";
            if (d.value >= 60) return "isohume-med";
            if (d.value >= 30) return "isohume";
            return "isohume-low";
        });
}

function drawWindRadii(container, pathGenerator, cyclone, pressureSystems, isPaused) {
    const currentMonth = cyclone.currentMonth || 6;
    if (!cyclone || cyclone.intensity < 34) return;

    const windData = [
        { threshold: 64, color: "#c0392b", active: cyclone.intensity >= 64, visualScale: 0.70 },
        { threshold: 50, color: "#e67e22", active: cyclone.intensity >= 50, visualScale: 0.85 },
        { threshold: 34, color: "#f1c40f", active: cyclone.intensity >= 34, visualScale: 1.00 }
    ];

    const SCAN_ANGLE_STEP = 10;
    const DRAW_ARC_STEP = 10;
    const STEP_KM = 15;
    const MAX_SEARCH_KM = 900;
    const SMOOTH_FACTOR = 0.5;
    const RMW_KM = 5 + cyclone.circulationSize * 0.125;

    if (!cyclone.radiiState) cyclone.radiiState = {};

    const PI_OVER_180 = Math.PI / 180;
    const DEG_PER_KM = 1 / 111.32;
    const centerLon = cyclone.lon;
    const centerLat = cyclone.lat;
    const lonScale = 1.0 / Math.max(0.1, Math.cos(centerLat * PI_OVER_180));

    // Pre-calculate trigonometric lookups
    const measureRadiusFast = (cosA, sinA, threshold) => {
        const peakDistDeg = RMW_KM * DEG_PER_KM;
        const peakLon = centerLon + peakDistDeg * cosA * lonScale;
        const peakLat = centerLat + peakDistDeg * sinA;

        if (getWindVectorAt(peakLon, peakLat, currentMonth, cyclone, pressureSystems).magnitude < threshold) return 0;

        let currentDist = RMW_KM;
        const stepDeg = STEP_KM * DEG_PER_KM;

        while (currentDist < MAX_SEARCH_KM) {
            const distDeg = currentDist * DEG_PER_KM;
            const sampleLon = centerLon + distDeg * cosA * lonScale;
            const sampleLat = centerLat + distDeg * sinA;
            if (getWindVectorAt(sampleLon, sampleLat, currentMonth, cyclone, pressureSystems).magnitude < threshold) return currentDist;
            currentDist += STEP_KM;
        }
        return currentDist;
    };

    const quadrants = [
        { id: 0, start: 0, end: 90 },
        { id: 1, start: 90, end: 180 },
        { id: 2, start: 180, end: 270 },
        { id: 3, start: 270, end: 360 }
    ];

    windData.forEach(level => {
        if (!level.active) return;
        if (!cyclone.radiiState[level.threshold]) cyclone.radiiState[level.threshold] = [0, 0, 0, 0];

        const polyPoints = [];
        let hasValidPoints = false;

        quadrants.forEach((quad, idx) => {
            let smoothedRadius = 0;
            const previousRadius = cyclone.radiiState[level.threshold][idx];

            if (isPaused && previousRadius > 0) {
                smoothedRadius = previousRadius;
            } else {
                let maxRadiusInQuad = 0;
                for (let angle = quad.start; angle <= quad.end; angle += SCAN_ANGLE_STEP) {
                    const rad = angle * PI_OVER_180;
                    let r = measureRadiusFast(Math.cos(rad), Math.sin(rad), level.threshold) * level.visualScale;
                    if (r > maxRadiusInQuad) maxRadiusInQuad = r;
                }

                smoothedRadius = (previousRadius === 0 && maxRadiusInQuad > 0)
                    ? maxRadiusInQuad
                    : previousRadius + (maxRadiusInQuad - previousRadius) * SMOOTH_FACTOR;

                cyclone.radiiState[level.threshold][idx] = smoothedRadius;
            }

            if (smoothedRadius < 5) {
                polyPoints.push([centerLon, centerLat]);
                return;
            }

            hasValidPoints = true;
            const distDeg = smoothedRadius * DEG_PER_KM;
            for (let angle = quad.start; angle <= quad.end; angle += DRAW_ARC_STEP) {
                const rad = angle * PI_OVER_180;
                polyPoints.push([
                    centerLon + distDeg * Math.cos(rad) * lonScale,
                    centerLat + distDeg * Math.sin(rad)
                ]);
            }
        });

        if (hasValidPoints && polyPoints.length > 2) {
            polyPoints.push(polyPoints[0]);
            if (d3.polygonArea(polyPoints) < 0) polyPoints.reverse();

            container.append("path")
                .datum({ type: "Polygon", coordinates: [polyPoints] })
                .attr("class", "wind-radii")
                .style("fill", level.color)
                .style("fill-rule", "evenodd")
                .style("stroke", d3.color(level.color).darker(0.5))
                .style("stroke-width", 0.8)
                .style("opacity", 0.4)
                .attr("d", pathGenerator);
        }
    });
}

let landCanvas = null;
let landCtx = null;
let windCanvasLayer = null;
let windCtx = null;
let landGrid = null;
let landGridWidth = 0;
let landGridHeight = 0;

function initLandGrid(world) {
    if (!world) return;

    const resolution = 8; // grid precision (0.125 deg)
    landGridWidth = 360 * resolution;
    landGridHeight = 180 * resolution;

    const canvas = document.createElement('canvas');
    canvas.width = landGridWidth;
    canvas.height = landGridHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const projection = d3.geoEquirectangular().fitSize([landGridWidth, landGridHeight], world);
    const path = d3.geoPath().projection(projection).context(ctx);

    ctx.fillStyle = '#FF0000';
    ctx.beginPath();
    path(world);
    ctx.fill();

    const imgData = ctx.getImageData(0, 0, landGridWidth, landGridHeight).data;
    landGrid = new Uint8Array(landGridWidth * landGridHeight);

    for (let i = 0; i < landGrid.length; i++) {
        if (imgData[i * 4] > 100) landGrid[i] = 1;
    }
}

function checkLandFast(lon, lat) {
    if (!landGrid) return false;
    let x = Math.max(0, Math.min(Math.floor((lon + 180) * (landGridWidth / 360)), landGridWidth - 1));
    let y = Math.max(0, Math.min(Math.floor((90 - lat) * (landGridHeight / 180)), landGridHeight - 1));
    return landGrid[y * landGridWidth + x] === 1;
}

export function drawWindField(mapSvg, mapProjection, cyclone, pressureSystems, world) {
    const currentMonth = cyclone.currentMonth || 6;
    const { width, height } = mapSvg.node().getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!landGrid && world) initLandGrid(world);

    if (!windCanvasLayer) {
        const container = mapSvg.node().parentNode;
        windCanvasLayer = document.createElement('canvas');
        windCanvasLayer.id = 'wind-canvas-layer';
        windCanvasLayer.style.position = 'absolute';
        windCanvasLayer.style.top = '0';
        windCanvasLayer.style.left = '0';
        windCanvasLayer.style.pointerEvents = 'none';
        windCanvasLayer.style.zIndex = '10';
        container.appendChild(windCanvasLayer);
        windCtx = windCanvasLayer.getContext('2d', { alpha: true });
    }

    const logicalWidth = windCanvasLayer.width / dpr;
    const logicalHeight = windCanvasLayer.height / dpr;

    if (logicalWidth !== width || logicalHeight !== height) {
        windCanvasLayer.width = width * dpr;
        windCanvasLayer.height = height * dpr;
        windCanvasLayer.style.width = `${width}px`;
        windCanvasLayer.style.height = `${height}px`;
        windCtx.scale(dpr, dpr);
    }

    windCtx.clearRect(0, 0, width, height);

    if (!world || !cyclone || cyclone.status !== 'active') return;

    const GEO_RANGE = 20;
    const GEO_STEP = 0.4;
    const arrowScale = 0.75;
    const headLen = 5;

    const maxCapacity = Math.ceil((GEO_RANGE / GEO_STEP) * (GEO_RANGE / GEO_STEP)) * 8;
    const batchLow = new Float32Array(maxCapacity);
    const batchHigh = new Float32Array(maxCapacity);
    const batchExt = new Float32Array(maxCapacity);
    let idxLow = 0, idxHigh = 0, idxExt = 0;

    const startLat = Math.floor(cyclone.lat - GEO_RANGE * 0.5);
    const endLat = Math.ceil(cyclone.lat + GEO_RANGE * 0.5);
    const startLon = Math.floor(cyclone.lon - GEO_RANGE);
    const endLon = Math.ceil(cyclone.lon + GEO_RANGE);

    const ANGLE_BACK = Math.PI * 0.85;

    for (let lat = startLat; lat <= endLat; lat += GEO_STEP) {
        if (lat < -90 || lat > 90) continue;

        for (let lon = startLon; lon <= endLon; lon += GEO_STEP) {
            const proj = mapProjection([lon, lat]);
            if (!proj || isNaN(proj[0]) || isNaN(proj[1])) continue;
            const x = proj[0], y = proj[1];

            if (x < -20 || x > width + 20 || y < -20 || y > height + 20) continue;

            let vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems);
            if (vec.magnitude <= 0) continue;

            const angle = Math.atan2(-vec.v, vec.u);
            const len = Math.min(20, vec.magnitude * arrowScale);
            const halfLen = len * 0.5;

            const dx = halfLen * Math.cos(angle);
            const dy = halfLen * Math.sin(angle);
            const p1x = x - dx, p1y = y - dy;
            const p2x = x + dx, p2y = y + dy;

            let h1x = p2x, h1y = p2y, h2x = p2x, h2y = p2y;

            if (len > 6) {
                h1x = p2x + headLen * Math.cos(angle + ANGLE_BACK);
                h1y = p2y + headLen * Math.sin(angle + ANGLE_BACK);
                h2x = p2x + headLen * Math.cos(angle - ANGLE_BACK);
                h2y = p2y + headLen * Math.sin(angle - ANGLE_BACK);
            }

            if (vec.magnitude > 50) {
                batchExt[idxExt++] = p1x; batchExt[idxExt++] = p1y; batchExt[idxExt++] = p2x; batchExt[idxExt++] = p2y;
                batchExt[idxExt++] = h1x; batchExt[idxExt++] = h1y; batchExt[idxExt++] = h2x; batchExt[idxExt++] = h2y;
            } else if (vec.magnitude > 30) {
                batchHigh[idxHigh++] = p1x; batchHigh[idxHigh++] = p1y; batchHigh[idxHigh++] = p2x; batchHigh[idxHigh++] = p2y;
                batchHigh[idxHigh++] = h1x; batchHigh[idxHigh++] = h1y; batchHigh[idxHigh++] = h2x; batchHigh[idxHigh++] = h2y;
            } else {
                batchLow[idxLow++] = p1x; batchLow[idxLow++] = p1y; batchLow[idxLow++] = p2x; batchLow[idxLow++] = p2y;
                batchLow[idxLow++] = h1x; batchLow[idxLow++] = h1y; batchLow[idxLow++] = h2x; batchLow[idxLow++] = h2y;
            }
        }
    }

    windCtx.lineWidth = 1.5;
    windCtx.lineCap = 'round';
    windCtx.lineJoin = 'round';

    const drawBatch = (batch, count, color) => {
        if (count === 0) return;
        windCtx.beginPath();
        windCtx.strokeStyle = color;
        for (let i = 0; i < count; i += 8) {
            windCtx.moveTo(batch[i], batch[i+1]);
            windCtx.lineTo(batch[i+2], batch[i+3]);
            windCtx.moveTo(batch[i+4], batch[i+5]);
            windCtx.lineTo(batch[i+2], batch[i+3]);
            windCtx.lineTo(batch[i+6], batch[i+7]);
        }
        windCtx.stroke();
    };

    drawBatch(batchLow, idxLow, "rgba(34, 211, 238, 0.6)");
    drawBatch(batchHigh, idxHigh, "rgba(252, 165, 165, 0.7)");
    drawBatch(batchExt, idxExt, "rgba(250, 120, 215, 0.8)");
}

export function drawForecastCone(container, mapProjection, pathForecasts) {
    if (!pathForecasts || pathForecasts.length === 0 || !pathForecasts[0].track || pathForecasts[0].track.length < 2) return;

    const forecastSteps = pathForecasts[0].track.length;
    const geoPath = d3.geoPath().projection(mapProjection);

    container.selectAll(".forecast-cone-container").remove();
    container.selectAll(".forecast-center-line").remove();

    const coneSegments = [];
    const meanTrackCoordinates = [];
    let lastStepData = null;

    const unwrapLon = (lon, refLon) => {
        let diff = lon - refLon;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return refLon + diff;
    };

    let rawDeathIndex = forecastSteps;
    for (let i = 0; i < forecastSteps; i++) {
        const avgInt = d3.mean(pathForecasts, f => f.track[i] ? f.track[i][2] : 0);
        if (avgInt <= 15) {
            rawDeathIndex = i;
            break;
        }
    }

    const keyframes = [8, 16, 24];
    let quantizedLimit = 8;
    for (let k of keyframes) {
        if (rawDeathIndex >= k) quantizedLimit = k;
        else break;
    }

    quantizedLimit = Math.min(quantizedLimit, forecastSteps - 1);
    let refLon = pathForecasts[0].track[0][0];

    for (let i = 0; i <= quantizedLimit; i++) {
        const unwrappedPoints = [];
        pathForecasts.forEach(f => {
            if (f.track[i]) unwrappedPoints.push([unwrapLon(f.track[i][0], refLon), f.track[i][1]]);
        });

        if (unwrappedPoints.length === 0) continue;

        const avgLonUnwrapped = d3.mean(unwrappedPoints, p => p[0]);
        const avgLat = d3.mean(unwrappedPoints, p => p[1]);

        refLon = avgLonUnwrapped;
        let avgLonNorm = avgLonUnwrapped;
        while (avgLonNorm > 180) avgLonNorm -= 360;
        while (avgLonNorm < -180) avgLonNorm += 360;

        meanTrackCoordinates.push([avgLonNorm, avgLat]);

        const stdDev = d3.deviation(unwrappedPoints, p => Math.hypot(p[0] - avgLonUnwrapped, p[1] - avgLat)) || 0;
        const radiusDeg = (0.25 + i * 0.14) + (stdDev * 0.6);
        const cosL = Math.cos(avgLat * Math.PI / 180);

        let angle = 0;
        if (i < quantizedLimit) {
            const nextUnwrapped = [];
            pathForecasts.forEach(f => { if(f.track[i+1]) nextUnwrapped.push([unwrapLon(f.track[i+1][0], refLon), f.track[i+1][1]]); });
            if (nextUnwrapped.length > 0) {
                angle = Math.atan2(d3.mean(nextUnwrapped, p => p[1]) - avgLat, (d3.mean(nextUnwrapped, p => p[0]) - avgLonUnwrapped) * cosL);
            }
        } else if (lastStepData) {
            angle = Math.atan2(avgLat - lastStepData.rawCenter[1], (avgLonUnwrapped - lastStepData.rawCenter[0]) * cosL);
        }

        const normal = angle + Math.PI / 2;
        let leftLon = avgLonUnwrapped + (radiusDeg * Math.cos(normal) / cosL);
        let rightLon = avgLonUnwrapped + (radiusDeg * Math.cos(normal + Math.PI) / cosL);

        const normalize = (lon) => {
            while (lon > 180) lon -= 360;
            while (lon < -180) lon += 360;
            return lon;
        };

        const currentStep = {
            rawCenter: [avgLonUnwrapped, avgLat],
            center: [avgLonNorm, avgLat],
            left: [normalize(leftLon), avgLat + (radiusDeg * Math.sin(normal))],
            right: [normalize(rightLon), avgLat + (radiusDeg * Math.sin(normal + Math.PI))],
            radiusDeg: radiusDeg
        };

        if (lastStepData) {
            coneSegments.push({
                type: "Feature",
                geometry: {
                    type: "Polygon",
                    coordinates: [[lastStepData.left, currentStep.left, currentStep.right, lastStepData.right, lastStepData.left]]
                }
            });
        }

        coneSegments.push({ type: "Feature", geometry: createGeoCircle(currentStep.center[0], currentStep.center[1], radiusDeg * 111.32) });
        lastStepData = currentStep;
    }

    let svg = d3.select(container.node().nearestViewportElement);
    if (svg.select("#cone-merge-filter").empty()) {
        svg.append("defs").append("filter").attr("id", "cone-merge-filter").append("feComponentTransfer").append("feFuncA").attr("type", "discrete").attr("tableValues", "0 1");
    }

    const coneGroup = container.append("g")
        .attr("class", "forecast-cone-container")
        .attr("filter", "url(#cone-merge-filter)")
        .style("opacity", 0.15);

    coneGroup.selectAll("path")
        .data(coneSegments)
        .enter().append("path")
        .attr("d", geoPath)
        .style("fill", "rgb(85, 105, 160)")
        .style("stroke", "none")
        .style("pointer-events", "none");

    if (meanTrackCoordinates.length > 1) {
        container.append("path")
            .datum({ type: "Feature", geometry: { type: "LineString", coordinates: meanTrackCoordinates } })
            .attr("class", "forecast-center-line")
            .attr("d", geoPath)
            .style("fill", "none")
            .style("stroke", "cyan")
            .style("stroke-width", 2)
            .style("stroke-dasharray", "4, 3")
            .style("opacity", 0.8)
            .style("pointer-events", "none");
    }

    const labelsToDraw = [8, 16, 24];
    labelsToDraw.forEach(idx => {
        if (idx > quantizedLimit) return;

        const step = pathForecasts[0].track[idx];
        if (step) {
            const proj = mapProjection([step[0], step[1]]);
            if (proj) {
                container.append("circle").attr("cx", proj[0]).attr("cy", proj[1]).attr("r", 3).attr("fill", "white");
                container.append("text")
                    .attr("x", proj[0]).attr("y", proj[1] - 7)
                    .attr("text-anchor", "middle")
                    .style("font-size", "10px")
                    .style("font-family", "Monospace")
                    .style("fill", "white")
                    .style("text-shadow", "0 1px 2px black")
                    .text(`+${idx * 3}h`);
            }
        }
    });
}

function drawPressureField(container, mapProjection, pressureSystemsObj) {
    const svgNode = container.node().closest('svg');
    const { width, height } = svgNode.getBoundingClientRect();
    const nx = 80, ny = Math.round(nx * height / width);

    const grid = new Float32Array(nx * ny);
    const systemsLayer = Array.isArray(pressureSystemsObj) ? pressureSystemsObj : (pressureSystemsObj.lower || []);

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) {
                grid[j * nx + i] = 1012;
                continue;
            }
            grid[j * nx + i] = getPressureAt(coords[0], coords[1], systemsLayer);
        }
    }

    const contours = d3.contours().size([nx, ny]).thresholds(d3.range(990, 1050, 2));
    const transform = d3.geoTransform({ point: function(x, y) { this.stream.point(x * width / nx, y * height / ny); } });
    const pathGenerator = d3.geoPath().projection(transform);

    container.append("g").selectAll("path").data(contours(grid)).enter().append("path")
        .attr("class", d => d.value > 1012 ? "isobar" : "isobar-low")
        .attr("d", pathGenerator);
}

export function drawMap(mapSvg, mapProjection, world, cyclone, options = {}) {
    if (!world || !mapSvg) return;

    const {
        pathForecasts = [],
        pressureSystems = [],
        showPressureField = false,
        showHumidityField = false,
        showPathForecast = false,
        showWindRadii = false,
        showPathPoints = false,
        showWindField = false,
        siteName = null,
        siteLon = null,
        siteLat = null,
        siteData = null,
        siteHistory = [],
        onSiteClick = null,
        isPaused = false,
        month = 8
    } = options;

    const layerNames = [
        "layer-static", "layer-humidity", "layer-pressure", "layer-forecast",
        "layer-track-lines", "layer-track-points", "layer-wind-radii",
        "layer-cyclone", "layer-pressure-handles", "track-interaction-layer", "layer-ui"
    ];

    layerNames.forEach(name => {
        if (mapSvg.select(`.${name}`).empty()) mapSvg.append("g").attr("class", name);
    });

    const staticLayer = mapSvg.select(".layer-static");
    const pressureLayer = mapSvg.select(".layer-pressure");
    const humidityLayer = mapSvg.select(".layer-humidity");
    const forecastLayer = mapSvg.select(".layer-forecast");
    const trackLineLayer = mapSvg.select(".layer-track-lines");
    const trackPointLayer = mapSvg.select(".layer-track-points");
    const windRadiiLayer = mapSvg.select(".layer-wind-radii");
    const cycloneLayer = mapSvg.select(".layer-cyclone");
    const uiLayer = mapSvg.select(".layer-ui");
    const pressureHandlesLayer = mapSvg.select(".layer-pressure-handles");

    const { width, height } = mapSvg.node().getBoundingClientRect();
    const pathGenerator = d3.geoPath().projection(mapProjection);

    if (cyclone && cyclone.status === 'active' && isFinite(cyclone.lon)) {
        mapProjection.center([cyclone.lon, cyclone.lat]).translate([width / 2, height / 2]);
    }

    if (staticLayer.select(".land").empty()) {
        staticLayer.append("path").datum(d3.geoGraticule().step([10, 10])).attr("class", "graticule");
        staticLayer.append("path").datum(world).attr("class", "land").style("stroke", "none");
    }

    staticLayer.select(".graticule").attr("d", pathGenerator);
    staticLayer.select(".land").attr("d", pathGenerator);

    if (showWindField && cyclone && cyclone.status === 'active') {
        drawWindField(mapSvg, mapProjection, cyclone, pressureSystems, world);
    } else {
        if (typeof windCtx !== 'undefined' && windCtx && typeof windCanvasLayer !== 'undefined' && windCanvasLayer) {
            windCtx.clearRect(0, 0, windCanvasLayer.width, windCanvasLayer.height);
        }
    }

    pressureLayer.selectAll("*").remove();
    if (showPressureField && cyclone && cyclone.status === 'active') {
        drawPressureField(pressureLayer, mapProjection, pressureSystems);
    }

    humidityLayer.selectAll("*").remove();
    if (showHumidityField && cyclone && cyclone.status === 'active') {
        drawHumidityField(humidityLayer, mapProjection, pressureSystems, cyclone, options.globalTemp);
    }

    windRadiiLayer.selectAll("*").remove();
    if (showWindRadii && cyclone && cyclone.status === 'active') {
        drawWindRadii(windRadiiLayer, pathGenerator, cyclone, pressureSystems, isPaused);
    }

    forecastLayer.selectAll("*").remove();
    if (showPathForecast && pathForecasts && pathForecasts.length > 0) {
        drawForecastCone(forecastLayer, mapProjection, pathForecasts);
    }

    if (cyclone && cyclone.track && cyclone.track.length > 1) {
        const segmentData = [];
        let lastLon = NaN;

        let currentUnwrapped = [0,0,0,0,0,0,0];

        for (let i = 0; i < cyclone.track.length; i++) {
            const p = cyclone.track[i];
            let lon = p[0];
            if (!isNaN(lastLon) && Math.abs(lon - lastLon) > 180) {
                lon += (lon < lastLon) ? 360 : -360;
            }
            lastLon = lon;

            const nextUnwrapped = [lon, p[1], p[2], p[3], p[4], p[5], p[6]];

            if (i > 0) {
                segmentData.push({
                    type: "LineString",
                    coordinates: [[currentUnwrapped[0], currentUnwrapped[1]], [nextUnwrapped[0], nextUnwrapped[1]]],
                    intensity: nextUnwrapped[2],
                    isT: nextUnwrapped[3],
                    isE: nextUnwrapped[4],
                    isS: nextUnwrapped[6]
                });
            }
            currentUnwrapped = nextUnwrapped;
        }

        trackLineLayer.selectAll(".storm-track")
            .data(segmentData)
            .join(
                enter => enter.append("path")
                    .attr("class", "storm-track")
                    .attr("d", pathGenerator)
                    .style("stroke", d => getCategory(d.intensity, d.isT, d.isE, d.isS).color),
                update => update
                    .attr("d", pathGenerator)
                    .style("stroke", d => getCategory(d.intensity, d.isT, d.isE, d.isS).color)
            );

        if (showPathPoints) {
            // need to recreate unwrapped track for points correctly, or use the unwrapped list logic
            const pointDisplayData = [];
            let pLastLon = NaN;
            for(let i=0; i<cyclone.track.length; i+=2) {
                 const p = cyclone.track[i];
                 let lon = p[0];
                 if (!isNaN(pLastLon) && Math.abs(lon - pLastLon) > 180) lon += (lon < pLastLon) ? 360 : -360;
                 pLastLon = lon;
                 pointDisplayData.push([lon, p[1], p[2], p[3], p[4], p[6]]);
            }

            trackPointLayer.selectAll("circle")
                .data(pointDisplayData)
                .join(
                    enter => enter.append("circle")
                        .attr("r", 4.5).attr("stroke", "#222222").attr("stroke-width", 1)
                        .attr("cx", d => mapProjection([d[0], d[1]])[0])
                        .attr("cy", d => mapProjection([d[0], d[1]])[1])
                        .style("fill", d => getCategory(d[2], d[3], d[4], d[5]).color),
                    update => update
                        .attr("cx", d => mapProjection([d[0], d[1]])[0])
                        .attr("cy", d => mapProjection([d[0], d[1]])[1])
                        .style("fill", d => getCategory(d[2], d[3], d[4], d[5]).color)
                );
        } else {
            trackPointLayer.selectAll("*").remove();
        }
    } else {
        trackLineLayer.selectAll("*").remove();
        trackPointLayer.selectAll("*").remove();
    }

    if (cyclone && cyclone.status === 'active') {
        cycloneLayer.selectAll("circle")
            .data([cyclone])
            .join(
                enter => enter.append("circle")
                    .attr("r", 7).attr("stroke", "white").attr("stroke-width", 1.5)
                    .attr("cx", d => mapProjection([d.lon, d.lat])[0])
                    .attr("cy", d => mapProjection([d.lon, d.lat])[1])
                    .attr("fill", d => getCategory(d.intensity, d.isTransitioning, d.isExtratropical, d.isSubtropical).color),
                update => update
                    .attr("cx", d => mapProjection([d.lon, d.lat])[0])
                    .attr("cy", d => mapProjection([d.lon, d.lat])[1])
                    .attr("fill", d => getCategory(d.intensity, d.isTransitioning, d.isExtratropical, d.isSubtropical).color)
                    .attr("class", d => d.intensity >= 96 && !d.isExtratropical ? "extreme-intensity-glow" : "")
            );
    } else {
        cycloneLayer.selectAll("*").remove();
    }

    pressureHandlesLayer.selectAll("*").remove();
    const activeSystemsList = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems.upper || []);

    if (showPressureField && cyclone && cyclone.status === 'active' && activeSystemsList.length > 0) {
        const significantSystems = activeSystemsList.filter(s => Math.abs(s.strength) > 5);
        drawInteractivePressureSystems(pressureHandlesLayer, mapProjection, significantSystems, pressureSystems, cyclone, options.onSystemRemove);
    }

    uiLayer.selectAll("*").remove();
    if (siteLon != null && siteLat != null && isFinite(siteLon) && isFinite(siteLat)) {
        drawSiteMarker(uiLayer, mapProjection, siteName, siteLon, siteLat, siteData, siteHistory, onSiteClick);
    }
}

function drawSiteMarker(container, projection, name, lon, lat, data, history, onClick) {
    const proj = projection([lon, lat]);
    if (!proj) return;
    const [siteX, siteY] = proj;
    const isSelected = data ? data.isSelected : false;
    const markerColor = isSelected ? "rgba(255, 255, 255, 0.8)" : "rgba(17, 24, 39, 0.5)";

    container.append("rect")
        .attr("x", siteX - 5).attr("y", siteY - 5)
        .attr("width", 10).attr("height", 10)
        .attr("fill", markerColor).attr("stroke", "white").attr("stroke-width", 1.5)
        .style("cursor", "pointer").style("pointer-events", "all")
        .on('mouseover', function() {
            d3.select(this).attr('fill', "rgba(255, 255, 255, 1.0)");
            d3.select(".tooltip").style("opacity", 0);
            d3.selectAll(".track-interaction-layer circle").style("opacity", 0);
        })
        .on('mousemove', (e) => e.stopPropagation())
        .on('mouseout', function() { d3.select(this).attr('fill', markerColor) })
        .on("click", (e) => { e.stopPropagation(); if (onClick) onClick(); });

    if (name) {
        container.append("text")
            .attr("x", siteX).attr("y", siteY + 16).attr("class", "site-label-name")
            .style("fill", "white").style("font-weight", "bold").style("font-size", "11px")
            .style("text-anchor", "middle").style("stroke", "black").style("stroke-width", "2px")
            .style("paint-order", "stroke").text(name);
    }

    if (data && data.label) {
        let windColor = "#22d3ee";
        const spd = data.displaySpeed || 0;
        if (spd >= 64) windColor = "#ff80ab";
        else if (spd >= 48) windColor = "#d500f9";
        else if (spd >= 34) windColor = "#ef4444";
        else if (spd >= 22) windColor = "#facc15";

        container.append("foreignObject")
            .attr("x", siteX - 60).attr("y", siteY - 22)
            .attr("width", 120).attr("height", 20).style("pointer-events", "none")
            .append("xhtml:div")
            .style("width", "100%").style("height", "100%").style("display", "flex")
            .style("align-items", "center").style("justify-content", "center")
            .style("text-align", "center").style("font-family", "Monospace")
            .style("font-size", "10px").style("font-weight", "bold")
            .style("color", windColor).style("text-shadow", "0 0 2px black, 0 0 4px black")
            .html(data.label);
    }
}

export function drawFinalPath(mapSvg, mapProjection, cyclone, world, tooltip, siteName, siteLon, siteLat, showPathPoints = false, finalStats = null, basin = 'WPAC', pressureSystems = [], showWindField = false, month = 8, siteHistory = [], siteData = null, onSiteClick = null) {
    if (!cyclone || !cyclone.track || cyclone.track.length < 2) return;
    mapSvg.select(".layer-track-lines").selectAll(".history-segment").remove();

    const { width, height } = mapSvg.node().getBoundingClientRect();

    let lastLon_center = NaN;
    const unwrappedTrackForCentering = cyclone.track.map(pointData => {
        let lon = pointData[0];
        if (!isNaN(lastLon_center) && Math.abs(lon - lastLon_center) > 180) {
            lon += (lon < lastLon_center) ? 360 : -360;
        }
        lastLon_center = lon;
        return [lon, pointData[1]];
    });

    const avgLon = d3.mean(unwrappedTrackForCentering, p => p[0]);
    const avgLat = d3.mean(unwrappedTrackForCentering, p => p[1]);

    if (isFinite(avgLon) && isFinite(avgLat)) {
        mapProjection.rotate([-avgLon, -avgLat]).center([0, 0]);
    }

    const fullTrackGeoJSON = { type: "LineString", coordinates: cyclone.track.map(p => [p[0], p[1]]) };
    const leftPad = width > 600 ? 360 : 100;
    mapProjection.fitExtent([[leftPad, 100], [width - 100, height - 100]], fullTrackGeoJSON);

    const cycloneForDisplay = { ...cyclone, status: 'history' };

    drawMap(mapSvg, mapProjection, world, cycloneForDisplay, {
        pathForecasts: [], pressureSystems, showPressureField: false, showHumidityField: false,
        showPathForecast: false, showWindRadii: false, siteName, siteLon, siteLat, showPathPoints,
        showWindField, month, siteHistory, siteData, onSiteClick
    });

    if (finalStats) {
        const infoBox = document.getElementById('map-info-box');
        if (infoBox) {
            document.getElementById('map-info-time').textContent = finalStats.number;
            document.getElementById('map-info-intensity').textContent = `${finalStats.peakWind}kt / ${finalStats.minPressure}hPa`;
            document.getElementById('map-info-movement').textContent = `ACE: ${finalStats.ace}`;
            infoBox.classList.remove('hidden');
        }
    } else {
         document.getElementById('map-info-box').classList.add('hidden');
    }

    let interactionLayer = mapSvg.select(".track-interaction-layer");
    let forecastLayer = mapSvg.select(".layer-forecast");

    if (forecastLayer.empty()) forecastLayer = mapSvg.insert("g", ".layer-ui").attr("class", "layer-forecast");
    if (interactionLayer.empty()) interactionLayer = mapSvg.insert("g", ".layer-ui").attr("class", "track-interaction-layer");

    interactionLayer.selectAll("*").remove();

    interactionLayer.append("rect")
        .attr("class", "interaction-overlay")
        .attr("width", width).attr("height", height)
        .style("fill", "transparent").style("cursor", "crosshair");

    const highlightCircle = interactionLayer.append("circle")
        .attr("class", "highlight-circle").attr("r", 9)
        .style("fill", "none").style("stroke", "white").style("stroke-width", "2px")
        .style("pointer-events", "none").style("opacity", 0);

    const selectedCircle = interactionLayer.append("circle")
        .attr("class", "selected-circle").attr("r", 7)
        .style("fill", "cyan").style("fill-opacity", 0.6).style("stroke", "none")
        .style("pointer-events", "none").style("opacity", 0);

    function findClosestPoint(mouseX, mouseY) {
        let closest = null, minDist = Infinity;
        cyclone.track.forEach((pointData, idx) => {
            const proj = mapProjection([pointData[0], pointData[1]]);
            if (!proj) return;
            const dist = Math.sqrt((mouseX - proj[0]) ** 2 + (mouseY - proj[1]) ** 2);
            if (dist < minDist) { minDist = dist; closest = { data: pointData, index: idx }; }
        });
        return minDist < 50 ? closest : null;
    }

    interactionLayer.select(".interaction-overlay")
        .on("mousemove", function(event) {
            const [mouseX, mouseY] = d3.pointer(event);
            const closestPoint = findClosestPoint(mouseX, mouseY);

            if (closestPoint) {
                const { data, index } = closestPoint;
                const [lon, lat, intensity, isT, isE, circulationSize, isS, , , , storedPressure] = data;

                const category = getCategory(intensity, isT, isE, isS);
                let pressure = (storedPressure !== undefined && storedPressure !== null) ? storedPressure :
                    Math.round(windToPressure(intensity, typeof circulationSize === 'number' ? circulationSize : 250, basin, getPressureAt(lon, lat, pressureSystems)));

                const latStr = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
                const lonValue = lon > 180 ? lon - 360 : (lon < -180 ? lon + 360 : lon);
                const lonStr = `${Math.abs(lonValue).toFixed(1)}°${lonValue >= 0 ? 'E' : 'W'}`;

                tooltip.transition().duration(50).style("opacity", .9);
                tooltip.html(
                    `<div style="text-align: center; font-family: 'JetBrains Mono', monospace; font-size: 11px;">
                        <strong style="color: #94a3b8;">T+${index * 3}h</strong><br/>
                        <span style="color: #cbd5e1;">${latStr} ${lonStr}</span><br/>
                        <span style="color:${category.color}; font-size:1.1em; font-weight:bold;">${intensity.toFixed(0)}KT / ${pressure}hPa</span><br/>
                        <span style="color: #64748b; font-size: 10px; text-transform: uppercase;">${category.shortName}</span>
                    </div>`
                ).style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");

                const proj = mapProjection([lon, lat]);
                if (proj) highlightCircle.attr("cx", proj[0]).attr("cy", proj[1]).style("fill", category.color).style("opacity", 1);
            } else {
                tooltip.style("opacity", 0);
                highlightCircle.style("opacity", 0);
            }
        })
        .on("click", function(event) {
            const [mouseX, mouseY] = d3.pointer(event);
            const closestPoint = findClosestPoint(mouseX, mouseY);
            forecastLayer.selectAll("*").remove();
            selectedCircle.style("opacity", 0);

            if (closestPoint) {
                const { data, index } = closestPoint;
                const proj = mapProjection([data[0], data[1]]);
                selectedCircle.attr("cx", proj[0]).attr("cy", proj[1]).style("opacity", 1);

                const snapAge = Math.floor((index * 3) / 6) * 6;
                if (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) {
                    drawForecastCone(forecastLayer, mapProjection, cyclone.forecastLogs[snapAge]);
                }

                window.dispatchEvent(new CustomEvent('cycloneTrackClick', { detail: { index: index } }));
            } else {
                window.dispatchEvent(new CustomEvent('cycloneTrackDeselect'));
            }
        })
        .on("mouseleave", () => { tooltip.style("opacity", 0); highlightCircle.style("opacity", 0); });
}

export function drawHistoricalIntensityChart(chartContainer, cycloneTrack, tooltip, mode = 'kt', basin = 'WPAC') {
    chartContainer.selectAll("*").remove();
    if (!cycloneTrack || cycloneTrack.length < 2) return;

    const { width, height } = chartContainer.node().getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const margin = {top: 20, right: 20, bottom: 30, left: 45};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const chartSvg = chartContainer.append("svg").attr("width", width).attr("height", height)
        .append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const intensityData = cycloneTrack.map((point, index) => {
        return {
            hour: index * 3,
            val: mode === 'kt' ? Math.round(point[2]) : (point[10] !== undefined && point[10] !== null ? point[10] : Math.round(windToPressure(Math.round(point[2]), point[5] || 300, basin))),
            isT: point[3], isE: point[4], isS: point[6]
        };
    });

    const maxHour = intensityData[intensityData.length - 1].hour;
    const x = d3.scaleLinear().domain([0, maxHour]).range([0, innerWidth]);
    let y;

    if (mode === 'kt') {
        y = d3.scaleLinear().domain([0, Math.max(30, d3.max(intensityData, d => d.val) * 1.05)]).range([innerHeight, 0]).nice();
    } else {
        y = d3.scaleLinear().domain([Math.min(1000, d3.min(intensityData, d => d.val) - 5), 1015]).range([innerHeight, 0]).nice();
    }

    chartSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${innerHeight})`)
        .call(d3.axisBottom(x).ticks(Math.min(5, maxHour / 12)).tickFormat(d => `${d}h`));
    chartSvg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}${mode === 'kt' ? 'kt' : ''}`));

    if (mode === 'kt') {
        const categoryBands = [
            { limit: 24, color: "#aaaaaa" }, { limit: 34, color: "#5dade2" }, { limit: 64, color: "#2ecc71" },
            { limit: 83, color: "#f1c40f" }, { limit: 96, color: "#f39c12" }, { limit: 113, color: "#e67e22" },
            { limit: 137, color: "#d35400" }, { limit: 170, color: "#c0392b" }
        ];
        let lastY = y(0);
        categoryBands.forEach(band => {
            const yVal = y(band.limit);
            chartSvg.append("rect").attr("x", 0).attr("y", yVal).attr("width", innerWidth).attr("height", Math.max(0, lastY - yVal))
                .attr("fill", band.color).attr("opacity", 0.15);
            lastY = yVal;
        });
    }

    const lineGen = d3.line().x(d => x(d.hour)).y(d => y(d.val));
    chartSvg.append("path").datum(intensityData).attr("fill", "none").attr("stroke", "white").attr("stroke-width", 2).attr("d", lineGen);

    const extLineGen = d3.line().x(d => x(d.hour)).y(d => y(d.val)).defined(d => d.isE);
    chartSvg.append("path").datum(intensityData).attr("fill", "none").attr("stroke", "#d500f9").attr("stroke-width", 2).attr("d", extLineGen);

    const focus = chartSvg.append("g").style("display", "none");
    focus.append("line").attr("y1", 0).attr("y2", innerHeight).attr("stroke", "white").attr("stroke-dasharray", "3,3").attr("opacity", 0.5);
    focus.append("circle").attr("r", 4).attr("fill", "white");

    chartSvg.append("rect").attr("width", innerWidth).attr("height", innerHeight).style("fill", "none").style("pointer-events", "all")
        .on("mouseover", () => { focus.style("display", null); tooltip.style("opacity", .9); })
        .on("mouseout", () => { focus.style("display", "none"); tooltip.style("opacity", 0); })
        .on("mousemove", function(event) {
            const x0 = x.invert(d3.pointer(event)[0]);
            const i = d3.bisector(d => d.hour).left(intensityData, x0, 1);
            const d = intensityData[i - 1];
            if (!d) return;

            focus.attr("transform", `translate(${x(d.hour)},${y(d.val)})`);
            const category = getCategory(mode === 'kt' ? d.val : cycloneTrack[i-1][2], d.isT, d.isE, d.isS);
            const unit = mode === 'kt' ? 'KT' : 'hPa';

            tooltip.html(`
                <div style="text-align: center;">
                    <strong class="text-slate-400">T+${d.hour}h</strong><br/>
                    <span style="color:white; font-size:1.1em">${d.val}${unit}</span><br/>
                    <span style="color:${category.color}; font-weight:bold; font-size:9px">${category.shortName}</span>
                </div>
            `).style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
        });
}

export function drawAllHistoryTracks(mapSvg, mapProjection, historyList, world) {
    if (!historyList || historyList.length === 0) return;

    ["layer-pressure", "layer-humidity", "layer-forecast", "layer-wind-radii", "layer-cyclone", "track-interaction-layer", "layer-ui", "layer-pressure-handles"]
        .forEach(cls => mapSvg.selectAll(`.${cls}`).selectAll("*").remove());

    const allSegments = [];
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;

    const firstTrack = historyList.find(h => h.cycloneData?.track?.length > 0);
    if (!firstTrack) return;
    const referenceLon = firstTrack.cycloneData.track[0][0];

    historyList.forEach(item => {
        const rawTrack = item.cycloneData.track;
        if (!rawTrack || rawTrack.length < 2) return;

        let lastUnwrappedLon = NaN;
        const unwrappedTrack = rawTrack.map((p, idx) => {
            let lon = p[0];
            if (!isNaN(lastUnwrappedLon)) {
                let diff = lon - lastUnwrappedLon;
                if (Math.abs(diff) > 180) lon += (diff > 0) ? -360 : 360;
            }

            if (idx === 0) {
                while (lon - referenceLon > 180) lon -= 360;
                while (lon - referenceLon < -180) lon += 360;
            } else {
                lon += Math.round((lastUnwrappedLon - p[0]) / 360) * 360;
            }

            lastUnwrappedLon = lon;
            minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);

            return [lon, p[1], p[2], p[3], p[4], p[5], p[6]];
        });

        for (let i = 0; i < unwrappedTrack.length - 1; i++) {
            allSegments.push({
                type: "Feature",
                properties: { color: getCategory(unwrappedTrack[i+1][2], unwrappedTrack[i+1][3], unwrappedTrack[i+1][4], unwrappedTrack[i+1][6]).color, name: item.name, intensity: unwrappedTrack[i+1][2] },
                geometry: { type: "LineString", coordinates: [unwrappedTrack[i].slice(0, 2), unwrappedTrack[i+1].slice(0, 2)] }
            });
        }
    });

    const { width, height } = mapSvg.node().getBoundingClientRect();
    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;

    mapProjection.rotate([-centerLon, 0]).center([0, centerLat]);
    mapProjection.fitExtent([[50, 50], [width - 50, height - 50]], { type: "LineString", coordinates: [[minLon, minLat], [maxLon, maxLat]] });

    drawMap(mapSvg, mapProjection, world, {status: 'history_all', track: []}, { pathForecasts: [], pressureSystems: [], showPressureField: false, showHumidityField: false, showPathForecast: false, showWindRadii: false, siteName: null, siteLon: null, siteLat: null });

    const trackLineLayer = mapSvg.select(".layer-track-lines");
    trackLineLayer.selectAll("*").remove();
    const pathGenerator = d3.geoPath().projection(mapProjection);

    trackLineLayer.selectAll(".history-segment")
        .data(allSegments).enter().append("path").attr("class", "history-segment").attr("d", pathGenerator)
        .style("fill", "none").style("stroke", d => d.properties.color).style("stroke-width", 1.8).style("stroke-opacity", 0.6).style("stroke-linecap", "round")
        .on("mouseover", function(event, d) {
            d3.select(this).style("stroke-opacity", 1.0).style("stroke-width", 4).style("stroke", "#ffffff").raise();
            const tooltip = d3.select(".tooltip");
            tooltip.transition().duration(50).style("opacity", .9);
            tooltip.html(`<div style="text-align:center"><strong>${d.properties.name}</strong><br/><span style="color:${d.properties.color}">${Math.round(d.properties.intensity)} KT</span></div>`)
                .style("left", (event.pageX + 10) + "px").style("top", (event.pageY - 20) + "px");
        })
        .on("mouseout", function(event, d) {
            d3.select(this).style("stroke-opacity", 0.6).style("stroke-width", 1.8).style("stroke", d.properties.color);
            d3.select(".tooltip").style("opacity", 0);
        });
}

function drawInteractivePressureSystems(container, mapProjection, renderableSystems, allPressureSystems, cyclone, onRemove) {
    const masterList = Array.isArray(allPressureSystems) ? allPressureSystems : (allPressureSystems.upper || []);
    const lowerList = Array.isArray(allPressureSystems) ? null : (allPressureSystems.lower || []);
    let viewCenterLon = mapProjection.center()[0];
    if (Math.abs(mapProjection.rotate()[0]) > 0.1) viewCenterLon = -mapProjection.rotate()[0];

    const getVisualLon = (dataLon) => {
        let diff = dataLon - viewCenterLon;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;
        return viewCenterLon + diff;
    };

    const handles = container.selectAll(".pressure-handle").data(renderableSystems);
    const enterHandles = handles.enter().append("g").attr("class", "pressure-handle").style("cursor", "grab");

    enterHandles.append("circle").attr("class", "halo").attr("r", 20).attr("fill", "none").attr("stroke", d => d.strength > 0 ? "#2980b9" : "#c0392b").attr("stroke-width", 1).attr("opacity", 0.3).style("pointer-events", "none");
    enterHandles.append("circle").attr("class", "core").attr("r", 12).attr("stroke", "white").attr("stroke-width", 1.5).attr("fill-opacity", 0.8);
    enterHandles.append("text").attr("dy", "0.35em").attr("text-anchor", "middle").style("font-family", "Arial, sans-serif").style("font-weight", "bold").style("font-size", "11px").style("fill", "white").style("pointer-events", "none");

    const allHandles = enterHandles.merge(handles);

    allHandles.on("dblclick", (event, d) => {
        event.stopPropagation();
        event.preventDefault();
        if (d.isManual && onRemove) onRemove(d);
    });

    allHandles.attr("transform", d => {
        const coords = mapProjection([getVisualLon(d.x), d.y]);
        return (!coords || isNaN(coords[0]) || isNaN(coords[1])) ? "translate(-9999, -9999)" : `translate(${coords[0]}, ${coords[1]})`;
    });

    allHandles.select(".core").attr("fill", d => d.strength > 0 ? "#2980b9" : "#c0392b");
    allHandles.select(".halo").attr("stroke", d => d.strength > 0 ? "#2980b9" : "#c0392b");
    allHandles.select("text").text(d => d.strength > 0 ? "H" : "L");

    const dragBehavior = d3.drag()
        .subject(function(event, d) { return { x: mapProjection([getVisualLon(d.x), d.y])[0], y: mapProjection([getVisualLon(d.x), d.y])[1] }; })
        .on("start", function(event, d) { d3.select(this).style("cursor", "grabbing"); d3.select(this).select(".core").attr("stroke", "#f1c40f").attr("stroke-width", 3); })
        .on("drag", function(event, d) {
            d3.select(this).attr("transform", `translate(${event.x}, ${event.y})`);
            const coords = mapProjection.invert([event.x, event.y]);
            if (coords) {
                const dx = coords[0] - d.x; const dy = coords[1] - d.y;
                d.x = coords[0]; d.y = coords[1];
                if (lowerList) {
                    const index = masterList.indexOf(d);
                    if (index !== -1 && lowerList[index]) { lowerList[index].x += dx; lowerList[index].y += dy; }
                }
            }
        })
        .on("end", function(event, d) {
            d3.select(this).style("cursor", "grab");
            d3.select(this).select(".core").attr("stroke", "white").attr("stroke-width", 1.5);
            const svg = d3.select(this.closest("svg"));

            const pressureLayer = svg.select(".layer-pressure");
            if (!pressureLayer.empty()) {
                pressureLayer.selectAll("*").remove();
                drawPressureField(pressureLayer, mapProjection, allPressureSystems);
            }

            if (cyclone && cyclone.status === 'active') {
                const forecastLayer = svg.select(".layer-forecast");
                if (!forecastLayer.empty()) {
                    forecastLayer.selectAll("*").remove();
                    const newForecasts = generatePathForecasts(cyclone, allPressureSystems, checkLandFast);
                    drawForecastCone(forecastLayer, mapProjection, newForecasts);
                }
            }
        });

    allHandles.call(dragBehavior);
    handles.exit().remove();
}

/**
 * JTWC Style Graphic rendering (Canvas)
 */
export function renderJTWCStyle(cyclone, timeIndex, worldData) {
    const width = 1600;
    const height = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');

    const unwrapLon = (lon, refLon) => {
        let diff = lon - refLon;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return refLon + diff;
    };

    const currentPointRaw = cyclone.track[timeIndex];
    const centerLon = currentPointRaw[0];
    const centerLat = currentPointRaw[1];

    const pastTrack = cyclone.track.slice(0, timeIndex + 1).map(p => [unwrapLon(p[0], centerLon), p[1], p[2]]);
    const currentPoint = pastTrack[timeIndex];

    const currentAge = timeIndex * 3;
    const snapAge = Math.floor(currentAge / 6) * 6;

    let forecastModelsRaw = (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) ? cyclone.forecastLogs[snapAge] : ((cyclone.status === 'active' && cyclone.pathForecasts) ? cyclone.pathForecasts : []);
    const forecastModels = forecastModelsRaw.map(model => ({ ...model, track: model.track.map(p => [unwrapLon(p[0], centerLon), p[1], p[2]]) }));

    const projection = d3.geoEquirectangular().rotate([-centerLon, 0]).center([0, centerLat]).scale(3500).translate([width / 2, height / 2]);
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    ctx.fillStyle = "#b8c8d8"; ctx.fillRect(0, 0, width, height);
    ctx.beginPath(); ctx.strokeStyle = "#888888"; ctx.lineWidth = 1; ctx.setLineDash([]);
    pathGenerator(d3.geoGraticule().step([2, 2])()); ctx.stroke();

    ctx.beginPath(); ctx.fillStyle = "#e8d888"; ctx.strokeStyle = "#555555"; ctx.lineWidth = 1;
    pathGenerator(worldData); ctx.fill(); ctx.stroke();

    const majorCities = [
        { name: "SAIPAN", lon: 145.7, lat: 15.2 }, { name: "MANILA", lon: 120.98, lat: 14.6 }, { name: "TAIPEI", lon: 121.5, lat: 25.05 },
        { name: "HONG KONG", lon: 114.17, lat: 22.3 }, { name: "YAP", lat: 9.51, lon: 138.12 }, { name: "SHANGHAI", lon: 121.47, lat: 31.23 },
        { name: "SEOUL", lon: 126.98, lat: 37.56 }, { name: "TOKYO", lon: 139.69, lat: 35.69 }, { name: "HO CHI MINH", lon: 106.63, lat: 10.82 },
        { name: "NAHA", lon: 127.68, lat: 26.21 }, { name: "GUAM", lon: 144.7, lat: 13.4 }, { name: "IWO TO", lon: 141.3, lat: 24.8 },
        { name: "HONOLULU", lon: -157.86, lat: 21.31 }, { name: "LOS ANGELES", lon: -118.24, lat: 34.05 }, { name: "NEW YORK", lon: -74.00, lat: 40.71 },
        { name: "BRISBANE", lon: 153.02, lat: -27.47 }, { name: "DARWIN", lon: 130.84, lat: -12.46 }, { name: "CAIRNS", lon: 145.77, lat: -16.92 }
    ];

    ctx.save(); ctx.fillStyle = "black"; ctx.font = "bold 11px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    majorCities.forEach(city => {
        const pos = projection([city.lon, city.lat]);
        if (pos && pos[0] > 10 && pos[0] < width - 10 && pos[1] > 10 && pos[1] < height - 10) {
            ctx.fillRect(pos[0] - 2, pos[1] - 2, 4, 4);
            if (pos[0] > width - 80) { ctx.textAlign = "right"; ctx.fillText(city.name, pos[0] - 5, pos[1]); }
            else { ctx.textAlign = "left"; ctx.fillText(city.name, pos[0] + 5, pos[1]); }
        }
    });
    ctx.restore();

    if (forecastModels.length > 0 && forecastModels[0].track.length > 1) {
        const maxSteps = d3.max(forecastModels, m => m.track.length);
        let rawDeathIndex = maxSteps;
        for (let i = 0; i < maxSteps; i++) {
            const points = [];
            forecastModels.forEach(m => { if(m.track[i]) points.push(m.track[i]); });
            if (points.length > 0 && d3.mean(points, p => p[2]) <= 15) { rawDeathIndex = i; break; }
        }

        let quantizedLimit = 8;
        for (let k of [4, 8, 12, 16, 24]) { if (rawDeathIndex >= k) quantizedLimit = k; else break; }
        quantizedLimit = Math.min(quantizedLimit, maxSteps - 1);

        const boundaryPoints = []; const rawSteps = []; const meanTrack = []; let maxRadiusSoFar = 0.02;

        for (let i = 0; i <= quantizedLimit; i++) {
            const pointsAtStep = [];
            forecastModels.forEach(m => { if (m.track[i]) pointsAtStep.push(m.track[i]); });
            if (pointsAtStep.length === 0) continue;

            const avgLon = d3.mean(pointsAtStep, p => p[0]), avgLat = d3.mean(pointsAtStep, p => p[1]);
            meanTrack.push([avgLon, avgLat]);

            const stdDev = d3.deviation(pointsAtStep, p => Math.hypot((p[0] - avgLon) * Math.cos(avgLat * Math.PI / 180), p[1] - avgLat)) || 0;
            let radiusDeg = Math.max(0.02, (0.02 + i * 0.14) + (stdDev * 1.5));
            maxRadiusSoFar = Math.max(maxRadiusSoFar, radiusDeg);
            rawSteps.push({ lon: avgLon, lat: avgLat, r: maxRadiusSoFar, cosL: Math.cos(avgLat * Math.PI / 180) });
        }

        for (let i = 0; i < rawSteps.length; i++) {
            const curr = rawSteps[i], prev = rawSteps[i - 1], next = rawSteps[i + 1];
            let dx = 0, dy = 0;
            if (i === 0 && next) { dx = (next.lon - curr.lon) * curr.cosL; dy = next.lat - curr.lat; }
            else if (i === rawSteps.length - 1 && prev) { dx = (curr.lon - prev.lon) * curr.cosL; dy = curr.lat - prev.lat; }
            else if (prev && next) { dx = (next.lon - prev.lon) * curr.cosL; dy = next.lat - prev.lat; }
            if (dx === 0 && dy === 0) { dx = 1; dy = 0; }

            const normal = Math.atan2(dy, dx) + Math.PI / 2;
            const pCenter = projection([curr.lon, curr.lat]);
            const pLeft = projection([curr.lon + (curr.r * Math.cos(normal) / curr.cosL), curr.lat + (curr.r * Math.sin(normal))]);
            const pRight = projection([curr.lon + (curr.r * Math.cos(normal + Math.PI) / curr.cosL), curr.lat + (curr.r * Math.sin(normal + Math.PI))]);

            if (pCenter && pLeft && pRight) boundaryPoints.push({ left: pLeft, right: pRight, center: pCenter, radius: Math.hypot(pLeft[0] - pCenter[0], pLeft[1] - pCenter[1]) });
        }

        const drawConePath = (context) => {
            if (boundaryPoints.length < 2) return;
            context.beginPath();
            context.moveTo(boundaryPoints[0].left[0], boundaryPoints[0].left[1]);
            for (let i = 0; i < boundaryPoints.length - 1; i++) {
                if (i === 0) context.lineTo((boundaryPoints[i].left[0] + boundaryPoints[i+1].left[0])/2, (boundaryPoints[i].left[1] + boundaryPoints[i+1].left[1])/2);
                else context.quadraticCurveTo(boundaryPoints[i].left[0], boundaryPoints[i].left[1], (boundaryPoints[i].left[0] + boundaryPoints[i+1].left[0])/2, (boundaryPoints[i].left[1] + boundaryPoints[i+1].left[1])/2);
            }
            context.lineTo(boundaryPoints[boundaryPoints.length - 1].left[0], boundaryPoints[boundaryPoints.length - 1].left[1]);

            const lastBP = boundaryPoints[boundaryPoints.length - 1];
            context.arc(lastBP.center[0], lastBP.center[1], lastBP.radius, Math.atan2(lastBP.left[1] - lastBP.center[1], lastBP.left[0] - lastBP.center[0]), Math.atan2(lastBP.right[1] - lastBP.center[1], lastBP.right[0] - lastBP.center[0]), false);

            for (let i = boundaryPoints.length - 2; i >= 0; i--) {
                if (i === boundaryPoints.length - 2) context.lineTo((boundaryPoints[i+1].right[0] + boundaryPoints[i].right[0])/2, (boundaryPoints[i+1].right[1] + boundaryPoints[i].right[1])/2);
                else context.quadraticCurveTo(boundaryPoints[i+1].right[0], boundaryPoints[i+1].right[1], (boundaryPoints[i+1].right[0] + boundaryPoints[i].right[0])/2, (boundaryPoints[i+1].right[1] + boundaryPoints[i].right[1])/2);
            }
            context.lineTo(boundaryPoints[0].right[0], boundaryPoints[0].right[1]);
            context.closePath();
        };

        const shapeCanvas = document.createElement('canvas'); shapeCanvas.width = width; shapeCanvas.height = height;
        const shapeCtx = shapeCanvas.getContext('2d');
        drawConePath(shapeCtx); shapeCtx.fillStyle = "#000000"; shapeCtx.fill();

        const patternCanvas = document.createElement('canvas'); patternCanvas.width = 16; patternCanvas.height = 16;
        const pCtx = patternCanvas.getContext('2d');
        pCtx.strokeStyle = "rgba(50, 200, 255, 0.4)"; pCtx.lineWidth = 2; pCtx.beginPath(); pCtx.moveTo(0, 16); pCtx.lineTo(16, 0); pCtx.stroke();

        shapeCtx.globalCompositeOperation = "source-in"; shapeCtx.fillStyle = ctx.createPattern(patternCanvas, 'repeat'); shapeCtx.fillRect(0, 0, width, height);
        ctx.drawImage(shapeCanvas, 0, 0);

        ctx.save(); drawConePath(ctx); ctx.strokeStyle = "#ff0000"; ctx.lineWidth = 2; ctx.setLineDash([12, 6]); ctx.stroke(); ctx.restore();

        if (meanTrack.length > 0) {
            ctx.beginPath(); ctx.strokeStyle = "#282888"; ctx.lineWidth = 2;
            pathGenerator({ type: "LineString", coordinates: meanTrack }); ctx.stroke(); ctx.setLineDash([]);
        }

        let lastLabelPos = null;
        [12, 24, 36, 48, 72].forEach(h => {
            const idx = h / 3;
            if (idx > quantizedLimit) return;
            const points = []; forecastModels.forEach(m => { if(m.track[idx]) points.push(m.track[idx]); });
            if (points.length === 0) return;

            const pos = projection([d3.mean(points, v=>v[0]), d3.mean(points, v=>v[1])]); if (!pos) return;
            const roundedIntensity = Math.round(d3.mean(points, v => v[2]) / 5) * 5;

            let nextP = null, prevP = null;
            if (idx + 1 < maxSteps) {
                const nextPoints = []; forecastModels.forEach(m => { if(m.track[idx+1]) nextPoints.push(m.track[idx+1]); });
                if (nextPoints.length > 0) nextP = projection([d3.mean(nextPoints, v=>v[0]), d3.mean(nextPoints, v=>v[1])]);
            }
            if (idx - 1 >= 0) {
                const prevPoints = []; forecastModels.forEach(m => { if(m.track[idx-1]) prevPoints.push(m.track[idx-1]); });
                if (prevPoints.length > 0) prevP = projection([d3.mean(prevPoints, v=>v[0]), d3.mean(prevPoints, v=>v[1])]);
            }

            let tangentAngle = (nextP && prevP) ? Math.atan2(nextP[1] - prevP[1], nextP[0] - prevP[0]) : ((nextP) ? Math.atan2(nextP[1] - pos[1], nextP[0] - pos[0]) : Math.atan2(pos[1] - prevP[1], pos[0] - prevP[0]));
            let normalAngle = tangentAngle + Math.PI / 2;
            let labelX = pos[0] + Math.cos(normalAngle) * 145, labelY = pos[1] + Math.sin(normalAngle) * 145;

            if (lastLabelPos && Math.abs(labelY - lastLabelPos.y) < 30) {
                normalAngle += Math.PI;
                labelX = pos[0] + Math.cos(normalAngle) * 145; labelY = pos[1] + Math.sin(normalAngle) * 145;
            }
            lastLabelPos = { x: labelX, y: labelY };

            ctx.beginPath(); ctx.fillStyle = "#282888"; ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.strokeStyle = "black"; ctx.lineWidth = 1; ctx.moveTo(pos[0], pos[1]); ctx.lineTo(labelX, labelY); ctx.stroke();

            const calcDate = new Date(Date.UTC(new Date().getFullYear(), (cyclone.currentMonth || 8) - 1, 1));
            calcDate.setUTCHours(calcDate.getUTCHours() + currentAge + h);

            let resultH = calcDate.getUTCHours();
            const rem = resultH % 6; resultH += (rem > 3) ? (6 - rem) : -rem;
            calcDate.setUTCHours(resultH, 0, 0, 0);

            const dateStr = `${String(calcDate.getUTCDate()).padStart(2,'0')}/${String(calcDate.getUTCHours()).padStart(2,'0')}Z`;
            ctx.fillStyle = "black"; ctx.font = "bold 20px 'JetBrains Mono', monospace"; ctx.textBaseline = "middle";
            ctx.textAlign = (labelX > pos[0]) ? "left" : "right";
            ctx.fillText(labelX > pos[0] ? `  ${dateStr}, ${roundedIntensity}KT` : `${dateStr}, ${roundedIntensity}KT  `, labelX, labelY);
        });
    }

    if (pastTrack.length > 0) {
        ctx.beginPath(); ctx.strokeStyle = "black"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.setLineDash([4, 2]);
        pathGenerator({ type: "LineString", coordinates: pastTrack.map(p => [p[0], p[1]]) }); ctx.stroke();
    }

    ctx.font = '900 16px "Font Awesome 6 Free"'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    pastTrack.forEach((p, i) => {
        if (i % 2 !== 0) return;
        const pos = projection(p); if (!pos) return;
        ctx.beginPath(); ctx.fillStyle = "white"; ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2); ctx.fill();

        if (p[2] >= 64) {
            ctx.fillStyle = "black"; ctx.fillText('\uf751', pos[0], pos[1]);
        } else if (p[2] >= 34) {
            ctx.setLineDash([]); ctx.strokeStyle = "black"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2); ctx.stroke();
        } else {
            ctx.strokeStyle = "black"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2); ctx.stroke();
        }
    });

    const currPos = projection(currentPoint);
    if (currPos) {
        ctx.beginPath(); ctx.fillStyle = "#ff0000"; ctx.strokeStyle = "black"; ctx.lineWidth = 2; ctx.arc(currPos[0], currPos[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "black"; ctx.font = "bold 20px Arial"; ctx.textAlign = "left";
        ctx.fillText(`${(cyclone.name || "NONAME").toUpperCase()}, ${Math.round(currentPoint[2] / 5) * 5}KT`, currPos[0] + 20, currPos[1] + 10);
    }

    ctx.fillStyle = "black"; ctx.fillRect(0, 0, width, 50); ctx.fillStyle = "white"; ctx.font = "bold 20px Arial"; ctx.textAlign = "left";
    ctx.fillText(`PROGNOSTIC REASONING: ${(cyclone.name || 'TD').toUpperCase()} #${timeIndex + 1}`, 20, 32);
    ctx.textAlign = "right"; ctx.fillText("INDEPENDENT CYCLONE WARNING CENTER", width - 20, 32);

    ctx.fillStyle = "red"; ctx.font = "bold 16px Arial"; ctx.textAlign = "center"; ctx.fillText("WARNING: THIS IS NOT REAL LOL / FOR SIMULATION ONLY", width / 2, height - 20);

    const legendW = 260, legendH = 210, legendX = width - legendW - 20, legendY = 60, iconX = legendX + 30;
    ctx.save(); ctx.fillStyle = "white"; ctx.strokeStyle = "black"; ctx.lineWidth = 1; ctx.fillRect(legendX, legendY, legendW, legendH); ctx.strokeRect(legendX, legendY, legendW, legendH);
    ctx.font = "bold 12px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillStyle = "black";

    let cY = legendY + 25;
    ctx.setLineDash([4,2]); ctx.beginPath(); ctx.arc(iconX, cY, 5, 0, Math.PI*2); ctx.stroke(); ctx.fillText("LESS THAN 34 KT", legendX + 50, cY); cY += 25;
    ctx.setLineDash([]); ctx.beginPath(); ctx.fillStyle="white"; ctx.arc(iconX, cY, 5, 0, Math.PI*2); ctx.fill(); ctx.stroke(); ctx.fillStyle="black"; ctx.fillText("34-63 KT", legendX + 50, cY); cY += 25;
    ctx.font = '900 12px "Font Awesome 6 Free"'; ctx.textAlign="center"; ctx.fillText('\uf751', iconX, cY); ctx.font="bold 12px Arial"; ctx.textAlign="left"; ctx.fillText("MORE THAN 63 KT", legendX + 50, cY); cY += 25;
    ctx.beginPath(); ctx.lineWidth = 3; ctx.moveTo(iconX - 15, cY); ctx.lineTo(iconX + 15, cY); ctx.stroke(); ctx.fillText("PAST CYCLONE TRACK", legendX + 50, cY); cY += 25;
    ctx.beginPath(); ctx.lineWidth = 2; ctx.setLineDash([8, 4]); ctx.moveTo(iconX - 15, cY); ctx.lineTo(iconX + 15, cY); ctx.stroke(); ctx.setLineDash([]); ctx.fillText("FORECAST CYCLONE TRACK", legendX + 50, cY); cY += 25;
    ctx.save(); const legPatCv = document.createElement('canvas'); legPatCv.width=10; legPatCv.height=10; const lpCtx = legPatCv.getContext('2d'); lpCtx.strokeStyle="rgba(60,220,255,0.4)"; lpCtx.lineWidth=2; lpCtx.beginPath(); lpCtx.moveTo(0,10); lpCtx.lineTo(10,0); lpCtx.stroke();
    ctx.fillStyle = ctx.createPattern(legPatCv, 'repeat'); ctx.strokeStyle="#ff0000"; ctx.lineWidth=2; ctx.setLineDash([4,2]); ctx.fillRect(iconX-15, cY-6, 30, 12); ctx.strokeRect(iconX-15, cY-6, 30, 12); ctx.restore(); ctx.fillText("UNCERTAINTY CONE AREA", legendX + 50, cY);
    ctx.restore();

    ctx.font = "900 32px 'Inter', sans-serif"; ctx.fillStyle = "rgba(0, 0, 0, 0.15)"; ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText("STORM_INC®", width - 20, height - 10);
    return canvas;
}

export function renderProbabilitiesStyle(cyclone, timeIndex, worldData, threshold = 34) {
    const width = 1600, height = 1200;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d');

    if (!cyclone || !cyclone.track) return canvas;

    const safeIndex = (timeIndex >= 0 && timeIndex < cyclone.track.length) ? timeIndex : cyclone.track.length - 1;
    const centerLon = cyclone.track[safeIndex][0]; const centerLat = cyclone.track[safeIndex][1];

    const projection = d3.geoEquirectangular().rotate([-centerLon, 0]).center([0, centerLat]).scale(3500).translate([width / 2, height / 2]);
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);
    const pxPerDeg = projection([1, 0])[0] - projection([0, 0])[0];

    ctx.fillStyle = "#6fa3cf"; ctx.fillRect(0, 0, width, height);
    ctx.beginPath(); ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); pathGenerator(d3.geoGraticule().step([5, 5])()); ctx.stroke(); ctx.setLineDash([]);

    const snapAge = Math.floor((safeIndex * 3) / 6) * 6;
    let forecasts = (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) ? cyclone.forecastLogs[snapAge] : (cyclone.pathForecasts || []);

    if (!forecasts || forecasts.length === 0 || !forecasts[0].track || forecasts[0].track.length === 0) return canvas;

    const radiusIndex = (threshold === 64) ? 9 : 7;
    let realRadiusPx = 0; const historyPoint = cyclone.track[safeIndex];
    if (historyPoint && historyPoint[radiusIndex] && Array.isArray(historyPoint[radiusIndex]) && Math.max(...historyPoint[radiusIndex]) > 0) {
        realRadiusPx = Math.max(...historyPoint[radiusIndex]) * pxPerDeg * 0.7;
    }
    if (realRadiusPx <= 0) realRadiusPx = (historyPoint[2] >= threshold) ? ((0.5 + (historyPoint[2] - threshold) * 0.015) * pxPerDeg * 0.7) : (16 - 0.2 * threshold);

    const gridW = 200, gridH = 150, values = new Float32Array(gridW * gridH).fill(0), track = forecasts[0].track;
    const scaleX = width / gridW, scaleY = height / gridH;

    for (let k = 0; k < track.length - 1; k++) {
        const pos1 = projection([track[k][0], track[k][1]]), pos2 = projection([track[k+1][0], track[k+1][1]]);
        if (!pos1 || !pos2) continue;

        const steps = Math.max(1, Math.ceil(Math.hypot(pos2[0] - pos1[0], pos2[1] - pos1[1]) / 15));
        for (let s = 0; s < steps; s++) {
            const t = s / steps, px = pos1[0] + (pos2[0] - pos1[0]) * t, py = pos1[1] + (pos2[1] - pos1[1]) * t;
            if (px < 0 || px >= width || py < 0 || py >= height) continue;

            const hour = (k + t) * 3, intensity = track[k][2] + (track[k+1][2] - track[k][2]) * t;
            const currentRadiusPx = (historyPoint[2] > threshold) ? realRadiusPx * Math.max(0.5, Math.min(1.5, intensity / historyPoint[2])) : ((intensity > threshold) ? (0.5 + (intensity - threshold) * 0.015) * pxPerDeg * 0.7 : 5);
            const jitteredRadius = currentRadiusPx * (1.0 + (Math.sin(hour * 2.5) * 0.1) + ((Math.random() - 0.5) * 0.15));

            const sigmaPx = ((40 + (hour * 5.5)) / 111.32) * pxPerDeg * 0.7;
            const maxProb = (1.0 / (1.0 + Math.exp(-1.5 * ((intensity - threshold) / (5 + hour * 0.25))))) * Math.max(0.0, 1.0 - (hour / (threshold === 64 ? 150 : 200))) * 100;
            if (maxProb < 1) continue;

            const influenceRad = jitteredRadius + sigmaPx * 2.5;
            const minGX = Math.max(0, Math.floor((px - influenceRad) / scaleX)), maxGX = Math.min(gridW - 1, Math.ceil((px + influenceRad) / scaleX));
            const minGY = Math.max(0, Math.floor((py - influenceRad) / scaleY)), maxGY = Math.min(gridH - 1, Math.ceil((py + influenceRad) / scaleY));
            const sigmaSq2 = 2 * sigmaPx * sigmaPx;

            for (let j = minGY; j <= maxGY; j++) {
                const idx = j * gridW;
                const dy = (j * scaleY) - py;
                const dy2 = dy * dy;
                for (let i = minGX; i <= maxGX; i++) {
                    const dx = (i * scaleX) - px;
                    const dist = Math.sqrt(dx * dx + dy2);
                    if (dist > jitteredRadius) {
                        const diff = dist - jitteredRadius;
                        const prob = Math.exp(-(diff * diff) / sigmaSq2) * maxProb;
                        if (prob > values[idx + i]) values[idx + i] = prob + (prob > 3 ? (Math.abs(Math.sin((i+k)*12.9898+(j+s)*78.233)*43758.5453)%1 - 0.5)*8.0 : 0);
                    } else {
                        if (maxProb > values[idx + i]) values[idx + i] = maxProb + (maxProb > 3 ? (Math.abs(Math.sin((i+k)*12.9898+(j+s)*78.233)*43758.5453)%1 - 0.5)*8.0 : 0);
                    }
                }
            }
        }
    }

    const thresholds = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90], colors = ["rgba(255,255,255,0)", "#008000", "#32cd32", "#adff2f", "#ffff00", "#ffd700", "#ffa500", "#ff4500", "#ff0000", "#8b0000", "#800080"];
    const contourPath = d3.geoPath().projection(d3.geoTransform({ point: function(x, y) { this.stream.point(x * scaleX, y * scaleY); } })).context(ctx);

    d3.contours().size([gridW, gridH]).thresholds(thresholds)(values).forEach((geometry, i) => {
        ctx.beginPath(); contourPath(geometry); ctx.fillStyle = colors[i + 1] || colors[colors.length - 1]; ctx.fill();
        if (thresholds[i] === 70) { ctx.lineWidth = 2; ctx.strokeStyle = "rgba(0, 0, 255, 0.7)"; ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; }
    });

    ctx.beginPath(); ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "black"; ctx.lineWidth = 1.0; pathGenerator(worldData); ctx.fill(); ctx.stroke();

    ctx.beginPath(); ctx.strokeStyle = "black"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    pathGenerator({ type: "LineString", coordinates: track.map(p => { let l = p[0]; while (l - track[0][0] > 180) l-=360; while (l - track[0][0] < -180) l+=360; return [l, p[1]]; }) });
    ctx.stroke(); ctx.setLineDash([]);

    ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, 70); ctx.strokeStyle = "black"; ctx.lineWidth = 2; ctx.strokeRect(0, 0, width, 70);
    ctx.fillStyle = "black"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const startDate = new Date(Date.UTC(new Date().getFullYear(), (cyclone.currentMonth || 8) - 1, 1)); startDate.setUTCHours(startDate.getUTCHours() + safeIndex * 3);
    ctx.font = "bold 28px Arial"; ctx.fillText(`${threshold} kt Wind Speed Probabilities (${(cyclone.name || "NONAME").toUpperCase()})`, width / 2, 25);
    ctx.font = "20px Arial"; ctx.fillText(`For the 72 hours (3.0 days) from ${startDate.toISOString().replace("T", " ").substring(0, 16) + ":00"}`, width / 2, 53);

    const legX = width - 60, legY = (height - 500) / 2; ctx.font = "bold 18px Arial"; ctx.textAlign = "left"; ctx.strokeRect(legX, legY, 30, 500);
    for (let i = 1; i < colors.length; i++) {
        const y = legY + 500 - (i * (500 / 10)); ctx.fillStyle = colors[i]; ctx.fillRect(legX, y, 30, 500 / 10);
        ctx.beginPath(); ctx.moveTo(legX, y); ctx.lineTo(legX + 30, y); ctx.stroke(); ctx.fillStyle = "black"; if (thresholds[i-1]) ctx.fillText(thresholds[i-1], legX + 38, y + (500 / 10));
    }
    ctx.fillText("99", legX + 38, legY + 10);
    return canvas;
}

export function drawStationGraph(containerId, historyData, type = 'wind') {
    const container = d3.select(containerId);
    container.selectAll("*").remove();

    if (!historyData || historyData.length === 0) return;

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 40, right: 30, bottom: 30, left: 40 };
    const width = rect.width - margin.left - margin.right;
    const height = rect.height - margin.top - margin.bottom;

    const svg = container.append("svg").attr("width", "100%").attr("height", "100%").attr("viewBox", `0 0 ${rect.width} ${rect.height}`).append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const x = d3.scaleLinear().domain(d3.extent(historyData, d => d.hour)).range([0, width]);

    svg.append("g").attr("transform", `translate(0,${height})`).attr("color", "#94a3b8").call(d3.axisBottom(x).ticks(5).tickFormat(d => `+${d}h`));

    const y = d3.scaleLinear().domain(type === 'wind' ? [0, Math.max(30, (d3.max(historyData, d => d.wind) || 10) * 1.1)] : [d3.min(historyData, d => d.pressure) - 2, d3.max(historyData, d => d.pressure) + 2]).range([height, 0]);
    const color = type === 'wind' ? "#22d3ee" : "#facc15";
    const unit = type === 'wind' ? "KT" : "hPa";

    svg.append("g").attr("color", "#94a3b8").call(d3.axisLeft(y).ticks(5));

    const line = d3.line().x(d => x(d.hour)).y(d => y(type === 'wind' ? d.wind : d.pressure)).curve(d3.curveLinear);
    svg.append("path").datum(historyData).attr("fill", "none").attr("stroke", color).attr("stroke-width", 4).attr("stroke-opacity", 0.1).attr("d", line);
    svg.append("path").datum(historyData).attr("fill", "none").attr("stroke", color).attr("stroke-width", 2).attr("d", line);

    if (type === 'wind') {
        const step = Math.max(1, Math.floor(historyData.length / (width / 40)));
        const barbGroup = svg.append("g").attr("class", "wind-barbs");

        historyData.filter((d, i) => i % step === 0).forEach(d => {
            const angleDeg = Math.atan2(-d.v, d.u) * (180 / Math.PI);
            const g = barbGroup.append("g").attr("transform", `translate(${x(d.hour)}, -15) rotate(${angleDeg}) scale(0.8)`);
            g.append("line").attr("x1", 0).attr("y1", 0).attr("x2", -20).attr("y2", 0).attr("stroke", "#64748b").attr("stroke-width", 1.5);

            let rem = Math.round(d.wind / 5) * 5, pos = -20;
            while (rem >= 50) { g.append("path").attr("d", `M${pos},0 L${pos+5},-10 L${pos+10},0`).attr("fill", "#64748b"); pos += 12; rem -= 50; }
            while (rem >= 10) { g.append("line").attr("x1", pos).attr("y1", 0).attr("x2", pos + 3).attr("y2", -8).attr("stroke", "#64748b").attr("stroke-width", 1.5); pos += 5; rem -= 10; }
            if (rem >= 5) g.append("line").attr("x1", pos).attr("y1", 0).attr("x2", pos + 1.5).attr("y2", -4).attr("stroke", "#64748b").attr("stroke-width", 1.5);
        });
    }

    const focus = svg.append("g").style("display", "none");
    focus.append("line").attr("y1", 0).attr("y2", height).style("stroke", "#94a3b8").style("stroke-dasharray", "3,3");
    focus.append("circle").attr("r", 4).style("fill", "#1e293b").style("stroke", color).style("stroke-width", 2);
    focus.append("rect").attr("width", 70).attr("height", 20).attr("rx", 3).attr("ry", 3).style("fill", "rgba(0,0,0,0.7)").style("pointer-events", "none");
    const focusText = focus.append("text").attr("y", -10).style("fill", "white").style("font-size", "10px").style("font-family", "Monospace").style("font-weight", "bold").style("text-anchor", "middle");

    svg.append("rect").attr("width", width).attr("height", height).style("fill", "none").style("pointer-events", "all").on("mouseover", () => focus.style("display", null)).on("mouseout", () => focus.style("display", "none")).on("mousemove", function(event) {
        const x0 = x.invert(d3.pointer(event)[0]), i = d3.bisector(d => d.hour).left(historyData, x0, 1), d0 = historyData[i - 1], d1 = historyData[i];
        let d = d0; if (d1 && d0) d = x0 - d0.hour > d1.hour - x0 ? d1 : d0; else if (d1) d = d1; if (!d) return;

        const posX = x(d.hour), posY = y(type === 'wind' ? d.wind : d.pressure);
        focus.attr("transform", `translate(${posX},${posY})`);
        focus.select("line").attr("y1", -posY).attr("y2", height - posY);
        focusText.text(`T+${d.hour}h: ${Math.round(type === 'wind' ? d.wind : d.pressure)}${unit}`);
        focus.select("rect").attr("x", posX + 40 > width ? -80 : 5).attr("y", -25);
        focusText.attr("x", posX + 40 > width ? -40 : 40).attr("y", -11);
    });
}

function addNoise(val, magnitude, seed) { return val + (Math.sin(seed * 12.9898) * magnitude); }

export function renderPhaseSpace(cyclone, globalTemp = 289) {
    const width = 800, height = 600, canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d');
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, width, height);

    const chartX = 60, chartY = 40, chartW = width - chartX - 180, chartH = height - chartY - 50;
    const dataPoints = [], rawPoints = [], month = cyclone.currentMonth || 8;

    cyclone.track.forEach((p, i) => {
        const sst = getSST(p[1], p[0], month, globalTemp);
        let B = 35.0 - (sst / 1.0), Vt = 0;

        if (!p[4]) {
            let latForcing = (Math.pow(Math.max(0, Math.abs(p[1]) - 15), 1.8) / 26.0) * (1.0 + (Math.cos((month - 1) / 12 * 2 * Math.PI) * (p[1] >= 0 ? 1 : -1) * 0.3)) * (i * 3 < 48 ? Math.pow(i * 3 / 48, 1.5) : 1.0);
            B += latForcing / (1.0 + 0.0 * Math.pow(p[2] / 40, 1.5));
            if (p[6]) B = Math.max(B, 15 + Math.random() * 5);
            Vt = ((p[2] * 1.4) - (28 - sst) * 10.0) * (p[6] ? 0.8 : 1.0) * Math.max(0.3, Math.min(1.1, (sst - 18) / 16));
        } else {
            B = 20 + (30 * Math.tanh((Math.abs(p[1]) - 20) / 15) * (1.0 + (Math.cos((month - 1) / 12 * 2 * Math.PI) * (p[1] >= 0 ? 1 : -1) * 0.2)));
            Vt = Math.max(-150, (p[2] * 1.0) - ((Math.abs(p[1]) - 20 * 0.6 * (1 + Math.sin((month - 2) / 12 * 2 * Math.PI))) * 4.0) - Math.max(0, (26 - sst) * 2.0));
        }

        rawPoints.push({ x: Math.max(0, Math.min(60, addNoise(B, 1.5, i))), y: addNoise(Vt, 3.0, i * 2), isExtra: p[4], isSub: p[6], intensity: p[2], hour: i * 3 });
    });

    for (let i = 0; i < rawPoints.length; i++) {
        let sumX = 0, sumY = 0, count = 0;
        for (let j = -1; j <= 1; j++) if (rawPoints[i+j]) { sumX += rawPoints[i+j].x; sumY += rawPoints[i+j].y; count++; }
        dataPoints.push({ ...rawPoints[i], x: sumX / count, y: sumY / count });
    }

    const minB = -10, maxB = 60, minVt = -150, maxVt = 250;
    const scaleX = val => chartX + ((val - minB) / (maxB - minB)) * chartW, scaleY = val => chartY + chartH - ((val - minVt) / (maxVt - minVt)) * chartH;

    ctx.fillStyle = "#fff1f2"; ctx.fillRect(scaleX(minB), scaleY(maxVt), scaleX(10) - scaleX(minB), scaleY(0) - scaleY(maxVt));
    ctx.fillStyle = "#fffbeb"; ctx.fillRect(scaleX(10), scaleY(maxVt), scaleX(maxB) - scaleX(10), scaleY(0) - scaleY(maxVt));
    ctx.fillStyle = "#f0f9ff"; ctx.fillRect(scaleX(minB), scaleY(0), scaleX(maxB) - scaleX(minB), scaleY(minVt) - scaleY(0));

    ctx.lineWidth = 1; ctx.strokeStyle = "#e2e8f0"; ctx.font = "10px Arial"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = -150; v <= 250; v += 50) { ctx.beginPath(); ctx.moveTo(chartX, scaleY(v)); ctx.lineTo(chartX + chartW, scaleY(v)); ctx.stroke(); ctx.fillStyle = "#64748b"; ctx.fillText(v, chartX - 5, scaleY(v)); }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let b = 0; b <= 60; b += 10) { ctx.beginPath(); ctx.moveTo(scaleX(b), chartY); ctx.lineTo(scaleX(b), chartY + chartH); ctx.stroke(); ctx.fillStyle = "#64748b"; ctx.fillText(b, scaleX(b), chartY + chartH + 5); }

    ctx.strokeStyle = "#334155"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(scaleX(10), chartY); ctx.lineTo(scaleX(10), chartY + chartH); ctx.stroke(); ctx.beginPath(); ctx.moveTo(chartX, scaleY(0)); ctx.lineTo(chartX + chartW, scaleY(0)); ctx.stroke();

    ctx.font = "bold 12px Arial"; ctx.textAlign = "left"; ctx.fillStyle = "#be123c"; ctx.fillText("DEEP WARM CORE", chartX + 10, chartY + 15); ctx.textAlign = "right"; ctx.fillStyle = "#b45309"; ctx.fillText("SHALLOW WARM / HYBRID", chartX + chartW - 10, chartY + 15); ctx.fillStyle = "#0369a1"; ctx.fillText("COLD CORE (EXTRATROPICAL)", chartX + chartW - 10, chartY + chartH - 15);
    ctx.save(); ctx.translate(15, chartY + chartH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillStyle = "#000"; ctx.fillText("Parameter -V_T : Thermal Wind (Lower-Trop)", 0, 0); ctx.restore(); ctx.textAlign = "center"; ctx.fillText("Parameter B : Thermal Asymmetry", chartX + chartW / 2, height - 10);

    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = 3;
    for (let i = 0; i < dataPoints.length - 1; i++) {
        ctx.beginPath(); ctx.moveTo(scaleX(dataPoints[i].x), scaleY(dataPoints[i].y)); ctx.lineTo(scaleX(dataPoints[i+1].x), scaleY(dataPoints[i+1].y));
        ctx.strokeStyle = dataPoints[i+1].y < 0 ? "#2563eb" : (dataPoints[i+1].x > 10 ? "#f59e0b" : "#dc2626");
        if (dataPoints[i+1].isExtra) ctx.strokeStyle = "#3b82f6";
        ctx.stroke();

        if (i > 0 && i % 8 === 0) { ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(scaleX(dataPoints[i].x), scaleY(dataPoints[i].y), 2.5, 0, Math.PI*2); ctx.fill(); ctx.font = "9px Arial"; ctx.fillText(`D${Math.floor(i / 8)}`, scaleX(dataPoints[i].x) + 6, scaleY(dataPoints[i].y) - 6); }
    }

    if (dataPoints.length > 0) {
        ctx.fillStyle = "#000"; ctx.font = "bold 16px Arial"; ctx.fillText("A", scaleX(dataPoints[0].x), scaleY(dataPoints[0].y));
        ctx.shadowBlur = 5; ctx.shadowColor = "rgba(255,255,255,1)"; ctx.beginPath(); ctx.arc(scaleX(dataPoints[dataPoints.length - 1].x), scaleY(dataPoints[dataPoints.length - 1].y), 6, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = "#fff"; ctx.font = "bold 10px Arial"; ctx.textBaseline = "middle"; ctx.fillText("Z", scaleX(dataPoints[dataPoints.length - 1].x), scaleY(dataPoints[dataPoints.length - 1].y));
    }

    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = "#64748b"; ctx.font = "bold 12px 'JetBrains Mono'"; ctx.fillText("CURRENT STATUS", chartX + chartW + 20, chartY);
    ctx.fillStyle = dataPoints[dataPoints.length - 1].y < 0 ? "#2563eb" : (dataPoints[dataPoints.length - 1].x > 10 ? "#d97706" : "#dc2626"); ctx.fillRect(chartX + chartW + 20, chartY + 20, 4, 35);
    ctx.fillStyle = "#0f172a"; ctx.font = "bold 20px 'JetBrains Mono'"; ctx.fillText(dataPoints[dataPoints.length - 1].y < 0 ? "COLD CORE" : (dataPoints[dataPoints.length - 1].x > 10 ? "SUBTROPICAL" : "TROPICAL"), chartX + chartW + 30, chartY + 20);
    ctx.fillStyle = "#64748b"; ctx.font = "11px 'JetBrains Mono'"; ctx.fillText(`B (Asym): ${dataPoints[dataPoints.length - 1].x.toFixed(1)}`, chartX + chartW + 30, chartY + 45); ctx.fillText(`-V_T: ${dataPoints[dataPoints.length - 1].y.toFixed(1)}`, chartX + chartW + 30, chartY + 60);
    ctx.textAlign = "right"; ctx.fillStyle = "#cbd5e1"; ctx.fillText("STORM_INC®", width - 10, height - 10);

    return canvas;
}

function renderNewsBackground(ctx, projection, width, height, worldData) {
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);
    ctx.fillStyle = "#0f3460"; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#16213e"; ctx.strokeStyle = "#4ecca3"; ctx.lineWidth = 1.5; pathGenerator(worldData); ctx.fill(); ctx.stroke();

    ctx.beginPath(); ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
    d3.geoGraticule().step([5, 5]).lines().forEach(l => { pathGenerator(l); ctx.stroke(); ctx.beginPath(); });

    ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.font = "12px 'JetBrains Mono'"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    const tl = projection.invert([0, 0]) || [-180, 90], br = projection.invert([width, height]) || [180, -90];

    for (let lat = Math.floor(Math.min(tl[1], br[1]) / 5) * 5; lat <= Math.ceil(Math.max(tl[1], br[1]) / 5) * 5; lat += 5) {
        const p = projection([tl[0], lat]); if (p && p[1] > 20 && p[1] < height - 20) ctx.fillText(`${lat}°N`, 10, p[1]);
    }
    ctx.textAlign = "center";
    for (let lon = Math.floor((((tl[0] + br[0]) / 2) - (360 / (projection.scale() / 100))) / 5) * 5; lon <= Math.ceil((((tl[0] + br[0]) / 2) + (360 / (projection.scale() / 100))) / 5) * 5; lon += 5) {
        const p = projection([lon, br[1]]);
        if (p && p[0] > 50 && p[0] < width - 50) {
            let displayLon = lon; while (displayLon > 180) displayLon -= 360; while (displayLon < -180) displayLon += 360;
            ctx.fillText(`${Math.abs(displayLon)}°${displayLon >= 0 ? 'E' : 'W'}`, p[0], height - 25);
        }
    }
}

export function startNewsAnimation(canvas, worldData, cyclone, pathForecasts, basin, simulationCount, pressureSystems, currentMonth, globalTemp, globalShear) {
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;

    if (!cyclone.track || cyclone.track.length === 0) return null;

    const refLon = cyclone.track[0][0];
    const fullTrackUnwrapped = cyclone.track.map(p => {
        let diff = p[0] - refLon;
        while (diff > 180) diff -= 360; while (diff < -180) diff += 360;
        return [refLon + diff, p[1], p[2]];
    });

    const forecastModels = (pathForecasts || []).map(model => ({
        ...model, track: model.track.map(p => {
            let diff = p[0] - refLon;
            while (diff > 180) diff -= 360; while (diff < -180) diff += 360;
            return [refLon + diff, p[1], p[2]];
        })
    }));

    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    [...fullTrackUnwrapped, ...forecastModels.flatMap(m => m.track)].forEach(p => {
        if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
    });

    const projection = d3.geoEquirectangular().rotate([-(minLon + maxLon) / 2, 0]).center([0, (minLat + maxLat) / 2]).translate([width / 2, height / 2]).scale(Math.min((width - 350) / (Math.max(10, maxLon - minLon) * Math.PI / 180), (height - 350) / (Math.max(8, maxLat - minLat) * Math.PI / 180)));

    const bgCanvas = document.createElement('canvas'); bgCanvas.width = width; bgCanvas.height = height;
    renderNewsBackground(bgCanvas.getContext('2d'), projection, width, height, worldData);

    const boundaryPoints = [];
    if (forecastModels.length > 0) {
        const stepData = [];
        for (let i = 0; i < d3.max(forecastModels, m => m.track.length); i++) {
            const pointsAtStep = []; forecastModels.forEach(m => { if (m.track[i]) pointsAtStep.push(m.track[i]); });
            if (pointsAtStep.length === 0) continue;
            const avgLon = d3.mean(pointsAtStep, p => p[0]), avgLat = d3.mean(pointsAtStep, p => p[1]);
            stepData.push({ lon: avgLon, lat: avgLat, r: Math.max(0.2, (0.05 + i * 0.12) + ((d3.deviation(pointsAtStep, p => Math.hypot((p[0] - avgLon) * Math.cos(avgLat * Math.PI / 180), p[1] - avgLat)) || 0) * 1.5)) });
        }
        stepData.forEach((curr, i) => {
            const cosL = Math.cos(curr.lat * Math.PI / 180), prev = i > 0 ? stepData[i-1] : null, next = i < stepData.length - 1 ? stepData[i+1] : null;
            const normal = ((prev && next) ? Math.atan2(next.lat - prev.lat, (next.lon - prev.lon) * cosL) : (next ? Math.atan2(next.lat - curr.lat, (next.lon - curr.lon) * cosL) : Math.atan2(curr.lat - prev.lat, (curr.lon - prev.lon) * cosL))) + Math.PI / 2;
            const pCenter = projection([curr.lon, curr.lat]), pLeft = projection([curr.lon + (curr.r * Math.cos(normal) / cosL), curr.lat + (curr.r * Math.sin(normal))]), pRight = projection([curr.lon + (curr.r * Math.cos(normal + Math.PI) / cosL), curr.lat + (curr.r * Math.sin(normal + Math.PI))]);
            if (pCenter && pLeft && pRight) boundaryPoints.push({ left: pLeft, right: pRight, center: pCenter, radius: Math.hypot(pLeft[0]-pCenter[0], pLeft[1]-pCenter[1]) });
        });
    }

    let animState = 'LOOP', frame = 0, loopCount = 0, zoomFrame = 0, streamlineBgCanvas = null, animationId = null;
    const particles = [], rotationDir = cyclone.lat < 0 ? 1 : -1, startDay = 1, monthIdx = (cyclone.currentMonth || 8) - 1, year = new Date().getFullYear();
    const initParticle = (p) => { p.x = Math.random() * width; p.y = Math.random() * height; p.age = Math.random() * 50; p.maxAge = 60 + Math.random() * 60; return p; };

    const render = () => {
        ctx.clearRect(0, 0, width, height);

        if (animState === 'LOOP') {
            ctx.drawImage(bgCanvas, 0, 0);

            if (boundaryPoints.length > 0 && frame > 180) {
                ctx.save(); ctx.globalAlpha = Math.min(1, (frame - 180) / 60);
                if (boundaryPoints.length >= 2) {
                    ctx.beginPath(); ctx.moveTo(boundaryPoints[0].left[0], boundaryPoints[0].left[1]);
                    for (let i = 1; i < boundaryPoints.length; i++) ctx.lineTo(boundaryPoints[i].left[0], boundaryPoints[i].left[1]);
                    ctx.arc(boundaryPoints[boundaryPoints.length - 1].center[0], boundaryPoints[boundaryPoints.length - 1].center[1], boundaryPoints[boundaryPoints.length - 1].radius, Math.atan2(boundaryPoints[boundaryPoints.length - 1].left[1] - boundaryPoints[boundaryPoints.length - 1].center[1], boundaryPoints[boundaryPoints.length - 1].left[0] - boundaryPoints[boundaryPoints.length - 1].center[0]), Math.atan2(boundaryPoints[boundaryPoints.length - 1].right[1] - boundaryPoints[boundaryPoints.length - 1].center[1], boundaryPoints[boundaryPoints.length - 1].right[0] - boundaryPoints[boundaryPoints.length - 1].center[0]), false);
                    for (let i = boundaryPoints.length - 2; i >= 0; i--) ctx.lineTo(boundaryPoints[i].right[0], boundaryPoints[i].right[1]);
                    ctx.closePath(); ctx.fillStyle = "rgba(255, 255, 255, 0.15)"; ctx.fill(); ctx.strokeStyle = "rgba(255, 255, 255, 0.4)"; ctx.lineWidth = 1; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
                }
                if (forecastModels.length > 0) {
                    ctx.beginPath(); ctx.strokeStyle = "white"; ctx.lineWidth = 2;
                    forecastModels[0].track.forEach((p, i) => { const pos = projection(p); if (pos) { if (i === 0) ctx.moveTo(pos[0], pos[1]); else ctx.lineTo(pos[0], pos[1]); } });
                    ctx.stroke(); ctx.fillStyle = "white";
                    forecastModels[0].track.forEach((p, idx) => { if (idx > 0 && idx % 8 === 0) { const pos = projection(p); if (pos) { ctx.beginPath(); ctx.arc(pos[0], pos[1], 4, 0, Math.PI*2); ctx.fill(); } } });
                }
                ctx.restore();
            }

            const currentIndex = Math.floor((fullTrackUnwrapped.length - 1) * Math.min(1, frame / 180));
            if (fullTrackUnwrapped.length > 0) {
                ctx.beginPath(); ctx.strokeStyle = "white"; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
                for (let i = 0; i < currentIndex; i++) {
                    const p1 = projection(fullTrackUnwrapped[i]), p2 = projection(fullTrackUnwrapped[i+1]);
                    if (p1 && p2) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); }
                }
                ctx.stroke();

                const headProj = projection(fullTrackUnwrapped[currentIndex]);
                if (headProj) {
                    ctx.beginPath(); ctx.fillStyle = "rgba(255, 255, 255, 0.2)"; ctx.arc(headProj[0], headProj[1], 30 + (10 + Math.sin(frame * 0.2) * 5), 0, Math.PI*2); ctx.fill();
                    ctx.font = '900 32px "Font Awesome 6 Free"'; ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    ctx.save(); ctx.translate(headProj[0], headProj[1]); ctx.rotate(frame * 0.1 * rotationDir); ctx.fillText('\uf751', 0, 0); ctx.restore();

                    const currentDate = new Date(Date.UTC(year, monthIdx, startDay)); currentDate.setUTCHours(currentDate.getUTCHours() + currentIndex * 3);
                    const labelText = `${cyclone.name ? cyclone.name.toUpperCase() : `${{'WPAC':'WP','EPAC':'EP','NATL':'AL','NIO':'IO','SHEM':'SH','SIO':'SH','SATL':'SL'}[basin]||'XX'} ${String(simulationCount).padStart(2, '0')}`}  ${String(currentDate.getUTCDate()).padStart(2, '0')}/${String(currentDate.getUTCHours()).padStart(2, '0')}Z`;

                    ctx.save(); ctx.font = "bold 18px 'JetBrains Mono'"; ctx.fillStyle = "rgba(15, 23, 42, 0.9)"; ctx.strokeStyle = "rgba(255, 255, 255, 0.2)"; ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.rect(headProj[0] + 40, headProj[1] - 40, ctx.measureText(labelText).width + 30, 36); ctx.fill(); ctx.stroke();
                    ctx.fillStyle = "#ef4444"; ctx.fillRect(headProj[0] + 40, headProj[1] - 40, 4, 36); ctx.fillStyle = "white"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
                    ctx.fillText(labelText, headProj[0] + 55, headProj[1] - 22); ctx.restore();
                }
            }

            if (++frame > 780) { frame = 0; if (++loopCount >= 4) { animState = 'ZOOM'; zoomFrame = 0; } }

        } else if (animState === 'ZOOM') {
            const t = (zoomFrame / 120) < .5 ? 2 * Math.pow(zoomFrame / 120, 2) : -1 + (4 - 2 * (zoomFrame / 120)) * (zoomFrame / 120);
            const headP = projection(fullTrackUnwrapped[fullTrackUnwrapped.length - 1]);

            ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(1 + (2.5 - 1) * t, 1 + (2.5 - 1) * t); ctx.translate(-((width / 2) * (1 - t) + headP[0] * t), -((height / 2) * (1 - t) + headP[1] * t));
            ctx.drawImage(bgCanvas, 0, 0);

            ctx.beginPath(); ctx.fillStyle = "rgba(255, 255, 255, 0.2)"; ctx.arc(headP[0], headP[1], 30 + (10 + Math.sin(Date.now() * 0.005) * 5), 0, Math.PI*2); ctx.fill();
            ctx.font = '900 32px "Font Awesome 6 Free"'; ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.save(); ctx.translate(headP[0], headP[1]); ctx.rotate((Date.now() / 1000) * rotationDir); ctx.fillText('\uf751', 0, 0); ctx.restore();
            ctx.restore();

            if (++zoomFrame > 120) { animState = 'STREAMLINE'; for(let k=0; k<1500; k++) particles.push(initParticle({})); }

        } else if (animState === 'STREAMLINE') {
            if (!streamlineBgCanvas) {
                streamlineBgCanvas = document.createElement('canvas'); streamlineBgCanvas.width = width; streamlineBgCanvas.height = height;
                projection.rotate([-fullTrackUnwrapped[fullTrackUnwrapped.length - 1][0], 0]).center([0, fullTrackUnwrapped[fullTrackUnwrapped.length - 1][1]]).translate([width/2, height/2]).scale(((width - 350) / (Math.max(10, maxLon - minLon) * Math.PI / 180)) * 2.5);
                renderNewsBackground(streamlineBgCanvas.getContext('2d'), projection, width, height, worldData);
            }
            ctx.drawImage(streamlineBgCanvas, 0, 0);

            ctx.lineWidth = 1.2; ctx.lineCap = "round";

            for (let i = 0; i < particles.length; i++) {
                const geo = projection.invert([particles[i].x, particles[i].y]);
                if (!geo) { initParticle(particles[i]); continue; }
                const vec = getWindVectorAt(geo[0], geo[1], cyclone.currentMonth || 8, cyclone, pressureSystems, globalTemp, globalShear);

                particles[i].x += vec.u * 0.2; particles[i].y -= vec.v * 0.2; particles[i].age++;

                const agePhase = particles[i].age < 15 ? particles[i].age / 15 : (particles[i].age > particles[i].maxAge - 15 ? (particles[i].maxAge - particles[i].age) / 15 : 0.5);

                ctx.save();
                ctx.globalAlpha = vec.magnitude > 48 ? agePhase : (vec.magnitude > 23 ? agePhase : agePhase * 0.4);
                ctx.strokeStyle = vec.magnitude > 48 ? "#ff5050" : (vec.magnitude > 23 ? "#ffdc64" : "#c8ffff");

                ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[i].x - vec.u * 0.6, particles[i].y + vec.v * 0.6);
                ctx.stroke(); ctx.restore();

                if (particles[i].age >= particles[i].maxAge || particles[i].x < 0 || particles[i].x > width || particles[i].y < 0 || particles[i].y > height) initParticle(particles[i]);
            }

            const headProj = projection(fullTrackUnwrapped[fullTrackUnwrapped.length - 1]);
            if (headProj) {
                ctx.font = '900 32px "Font Awesome 6 Free"'; ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.save(); ctx.translate(headProj[0], headProj[1]); ctx.rotate((Date.now() / 1000) * rotationDir); ctx.fillText('\uf751', 0, 0); ctx.restore();
            }

            ctx.fillStyle = "rgba(0,0,0,0.8)"; ctx.fillRect(width - 260, 80, 240, 40);
            ctx.fillStyle = "#4ade80"; ctx.font = "bold 16px 'JetBrains Mono'"; ctx.textAlign = "right"; ctx.fillText("● LIVE WIND FIELD", width - 40, 105);
        }
        animationId = requestAnimationFrame(render);
    };

    render();
    return () => { if (animationId) cancelAnimationFrame(animationId); };
}

export function renderStationSynopticChart(cyclone, timeIndex, worldData, pressureSystems, stationLon, stationLat, stationName) {
    const width = 1600, height = 1200, canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d');

    const safeIndex = (timeIndex >= 0 && timeIndex < cyclone.track.length) ? timeIndex : cyclone.track.length - 1;
    const currentPoint = cyclone.track[safeIndex];
    const projection = d3.geoEquirectangular().rotate([-((stationLon != null) ? stationLon : currentPoint[0]), 0]).center([0, ((stationLat != null) ? stationLat : currentPoint[1])]).scale(4000).translate([width / 2, height / 2]);
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    ctx.fillStyle = "#aed6f1"; ctx.fillRect(0, 0, width, height);
    ctx.beginPath(); ctx.fillStyle = "#f9e79f"; ctx.strokeStyle = "#999"; ctx.lineWidth = 1; pathGenerator(worldData); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 1; ctx.setLineDash([5, 5]); pathGenerator(d3.geoGraticule().step([1, 1])()); ctx.stroke(); ctx.setLineDash([]);

    const nx = 200, ny = 150, gridValues = new Float32Array(nx * ny), systemsLayer = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems.lower || []);
    const Pc = windToPressure(currentPoint[2], currentPoint[5] || cyclone.circulationSize || 300, cyclone.basin || 'WPAC', getPressureAt(currentPoint[0], currentPoint[1], systemsLayer, false));
    const Rmw = 10 + (currentPoint[5] || cyclone.circulationSize || 300) * 0.25;

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = projection.invert([i * width / nx, j * height / ny]);
            if (!coords) { gridValues[j * nx + i] = 1012; continue; }
            gridValues[j * nx + i] = calculateHollandPressure(calculateDistance(coords[1], coords[0], currentPoint[1], currentPoint[0]), Rmw, Pc, getPressureAt(coords[0], coords[1], systemsLayer, false));
        }
    }

    const contourPath = d3.geoPath().projection(d3.geoTransform({ point: function(x, y) { this.stream.point(x * (width / nx), y * (height / ny)); } })).context(ctx);
    d3.contours().size([nx, ny]).thresholds(d3.range(880, 1040, 2))(gridValues).forEach(c => {
        ctx.beginPath(); contourPath(c);
        ctx.lineWidth = c.value % 10 === 0 ? 2.5 : (c.value % 4 === 0 ? 1.0 : 0.5);
        ctx.strokeStyle = c.value % 10 === 0 ? "#2c3e50" : (c.value % 4 === 0 ? "#566573" : "rgba(86, 101, 115, 0.5)");
        ctx.stroke();
    });

    if (stationLon != null && stationLat != null) {
        const sPos = projection([stationLon, stationLat]);
        if (sPos) {
            ctx.beginPath(); ctx.arc(sPos[0], sPos[1], 8, 0, Math.PI*2); ctx.fillStyle = "red"; ctx.fill(); ctx.lineWidth=2; ctx.strokeStyle="white"; ctx.stroke();
            ctx.fillStyle = "black"; ctx.font = "bold 24px Arial"; ctx.textAlign = "left"; ctx.fillText((stationName || "STATION").toUpperCase(), sPos[0] + 15, sPos[1] + 8);
            ctx.fillStyle = "blue"; ctx.font = "bold 20px Monospace"; ctx.fillText(`${Math.round(calculateHollandPressure(calculateDistance(stationLat, stationLon, currentPoint[1], currentPoint[0]), Rmw, Pc, getPressureAt(stationLon, stationLat, systemsLayer, false)))} hPa`, sPos[0] + 15, sPos[1] + 32);
        }
    }

    const cPos = projection([currentPoint[0], currentPoint[1]]);
    if (cPos) {
        ctx.font = '900 40px "Font Awesome 6 Free"'; ctx.fillStyle = "#c0392b"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText('\uf751', cPos[0], cPos[1]);
        ctx.fillStyle = "black"; ctx.font = "bold 20px Arial"; ctx.fillText(`L(${Math.round(Pc)})`, cPos[0], cPos[1] + 40);
    }

    ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, 60); ctx.strokeStyle = "black"; ctx.lineWidth = 2; ctx.strokeRect(0, 0, width, 60);
    ctx.fillStyle = "black"; ctx.textAlign = "left"; ctx.font = "bold 24px Arial"; ctx.textBaseline = "middle"; ctx.fillText("LOCAL SYNOPTIC ANALYSIS (MSLP)", 20, 30);

    const simDate = new Date(Date.UTC(new Date().getFullYear(), (cyclone.currentMonth || 8) - 1, 1)); simDate.setUTCHours(simDate.getUTCHours() + timeIndex * 3);
    ctx.textAlign = "right"; ctx.fillText(`VALID: ${simDate.toISOString().replace("T", " ").substring(0, 16)}Z`, width - 20, 30);
    ctx.font = "900 32px 'Inter', sans-serif"; ctx.fillStyle = "rgba(0, 0, 0, 0.15)"; ctx.textBaseline = "bottom"; ctx.fillText("STORM_INC®", width - 20, height - 10);

    return canvas;
}
