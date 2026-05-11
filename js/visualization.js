/**
 * js/visualization.js
 * Contains all D3.js and canvas rendering logic for the map and diagnostic charts
 */
import { getCategory, getPressureAt, windToPressure, directionToCompass, createGeoCircle, unwrapLongitude, calculateHollandPressure, getSST, calculateDistance } from './utils.js';
import { getWindVectorAt } from './cyclone-model.js';
import { generatePathForecasts } from './forecast-models.js';
import { getElevationAt, getLandStatus } from './terrain-data.js';

const THEME = {
    bg0: '#1a1918', bg1: '#1a1918', bg2: '#242322', bg3: '#33312e',
    border: '#33312e', borderHi: '#4a4743',
    accent: '#ff4d6a', accentDim: '#cc3d55',
    amber: '#f0a84d', green: '#4ade80',
    text: '#e8e6e1', textMuted: '#a3a099', textDim: '#807d78',
    font: 'ui-monospace, "JetBrains Mono", monospace'
};

// pseudo-random noise for atmospheric humidity modeling
function pseudoNoise(x, y) {
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return n - Math.floor(n);
}

// bilinear interpolated smooth noise
export function smoothNoise(x, y) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const u = x - i;
    const v = y - j;
    
    const smooth = t => t * t * (3 - 2 * t);
    const uSm = smooth(u);
    const vSm = smooth(v);

    const n00 = pseudoNoise(i, j);
    const n10 = pseudoNoise(i + 1, j);
    const n01 = pseudoNoise(i, j + 1);
    const n11 = pseudoNoise(i + 1, j + 1);

    const x1 = n00 + (n10 - n00) * uSm;
    const x2 = n01 + (n11 - n01) * uSm;
    
    return x1 + (x2 - x1) * vSm;
}

// calculates ambient background humidity independent of the cyclone core
export function calculateBackgroundHumidity(lon, lat, pressureSystems, currentMonth, cyclone = null, globalTemp = 289) {
    const p = getPressureAt(lon, lat, pressureSystems);
    let hum = 83 + (1010 - p) * 1.3 + 3 * (globalTemp - 289);

    const timeFactor = (cyclone && cyclone.age) ? cyclone.age * 0.02 : 0;
    const scale = 0.06; 
    const noise = smoothNoise(lon * scale + timeFactor, lat * scale);
    hum += (noise - 0.5) * 35;

    const latRad = lat * Math.PI / 180;
    hum *= (0.6 + 0.4 * Math.cos(latRad));

    const isNorth = lat > 0;
    let baseDryLat = isNorth ? 46 : -46;
    const systemsList = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems?.lower || []);
    
    if (systemsList.length > 0) {
        const subpolarLow = systemsList.find(s => s.baseSigmaX > 200 && s.strength < -15 && (isNorth ? s.y > 30 : s.y < -30));
        if (subpolarLow) {
            baseDryLat = subpolarLow.y + (isNorth ? 5 : -8);
        }
    }

    // Rossby wave/jet stream influence
    const waveNumber = 5.0;
    const phaseSpeed = (cyclone ? cyclone.age : 0) * 0.02;
    const rossbyOffset = Math.sin((lon * Math.PI / 180) * waveNumber + phaseSpeed) * 6.0;
    const jetNoise = (smoothNoise(lon * 0.08, timeFactor) - 0.5) * 8.0;

    const targetDryLat = baseDryLat + rossbyOffset + jetNoise;
    const westerliesDryFactor = Math.exp(-Math.pow(lat - targetDryLat, 2) / 200);
    hum -= westerliesDryFactor * 100;

    // Foehn effect/ortographic drag
    const elevation = getElevationAt(lon, lat);
    if (elevation > 0) hum -= (elevation / 200) * 15;

    if (cyclone) {
        const vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems);
        const len = Math.hypot(vec.u, vec.v);
        let windWeight = Math.max(0, Math.min(1, (len - 15.0) / 15.0));

        if (windWeight > 0.01) {
            const dirU = vec.u / len;
            const dirV = vec.v / len;
            const traceSteps = 30, stepSize = 0.1, decayFactor = 0.2;
            let maxDryImpact = 0;

            for (let i = 1; i <= traceSteps; i++) {
                const dist = i * stepSize;
                const upElevation = getElevationAt(lon - (dirU * dist), lat - (dirV * dist));
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
        const dist = Math.hypot(dx, dy);
        
        // CDO core hydration
        if (dist < cyclone.circulationSize * 0.01) { 
            hum += Math.max(0, 50 * (1 - dist / (cyclone.circulationSize * 0.01)));
        }
        // spiral rainbands
        if (dist < cyclone.circulationSize * 0.02) {
            const angle = Math.atan2(dy, dx);
            if (Math.sin(angle * 3 + dist * 2 - (cyclone.age || 0) * 0.1) > 0.5) hum += 10;
        }
    }
    return Math.max(10, Math.min(99, hum));
}

export function drawHumidityField(container, mapProjection, pressureSystems, cyclone, globalTemp) {
    const svgNode = container.node().closest('svg'); 
    const { width, height } = svgNode.getBoundingClientRect();
    const nx = 56, ny = Math.round(nx * height / width);
    const grid = [];

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) {
                grid.push(0); continue;
            }
            grid.push(calculateTotalHumidity(coords[0], coords[1], pressureSystems, cyclone, globalTemp));
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
    if (!cyclone || cyclone.intensity < 34) return;
    const currentMonth = cyclone.currentMonth || 6;
    
    const windData = [
        { threshold: 64, color: THEME.accent, active: cyclone.intensity >= 64, visualScale: 0.70 },
        { threshold: 50, color: THEME.amber, active: cyclone.intensity >= 50, visualScale: 0.85 },
        { threshold: 34, color: THEME.green, active: cyclone.intensity >= 34, visualScale: 1.00 }
    ];

    const SCAN_ANGLE_STEP = 10, DRAW_ARC_STEP = 10, STEP_KM = 15, MAX_SEARCH_KM = 900, SMOOTH_FACTOR = 0.5;
    const RMW_KM = 5 + cyclone.circulationSize * 0.125;
    if (!cyclone.radiiState) cyclone.radiiState = {};

    const getPointAt = (centerLon, centerLat, angleRad, distKm) => {
        const distDeg = distKm / 111.32; 
        const lonScale = 1.0 / Math.max(0.1, Math.cos(centerLat * Math.PI / 180));
        return [centerLon + distDeg * Math.cos(angleRad) * lonScale, centerLat + distDeg * Math.sin(angleRad)];
    };

    const measureRadiusAtAngle = (angleRad, threshold) => {
        const [peakLon, peakLat] = getPointAt(cyclone.lon, cyclone.lat, angleRad, RMW_KM);
        if (getWindVectorAt(peakLon, peakLat, currentMonth, cyclone, pressureSystems).magnitude < threshold) return 0; 

        let currentDist = RMW_KM;
        while (currentDist < MAX_SEARCH_KM) {
            const [sampleLon, sampleLat] = getPointAt(cyclone.lon, cyclone.lat, angleRad, currentDist);
            if (getWindVectorAt(sampleLon, sampleLat, currentMonth, cyclone, pressureSystems).magnitude < threshold) return currentDist;
            currentDist += STEP_KM;
        }
        return currentDist;
    };

    const quadrants = [{ id: 0, start: 0, end: 90 }, { id: 1, start: 90, end: 180 }, { id: 2, start: 180, end: 270 }, { id: 3, start: 270, end: 360 }];

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
                    const r = measureRadiusAtAngle(angle * (Math.PI / 180), level.threshold) * level.visualScale;
                    if (r > maxRadiusInQuad) maxRadiusInQuad = r;
                }
                smoothedRadius = (previousRadius === 0 && maxRadiusInQuad > 0) ? maxRadiusInQuad : previousRadius + (maxRadiusInQuad - previousRadius) * SMOOTH_FACTOR;
                cyclone.radiiState[level.threshold][idx] = smoothedRadius;
            }

            if (smoothedRadius < 5) {
                polyPoints.push(getPointAt(cyclone.lon, cyclone.lat, 0, 0));
                return;
            }

            hasValidPoints = true;
            for (let angle = quad.start; angle <= quad.end; angle += DRAW_ARC_STEP) {
                polyPoints.push(getPointAt(cyclone.lon, cyclone.lat, angle * (Math.PI / 180), smoothedRadius));
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
                .style("stroke", level.color)
                .style("stroke-width", 0.8)
                .style("opacity", 0.2)
                .attr("d", pathGenerator);
        }
    });
}

let landGrid = null, landGridWidth = 0, landGridHeight = 0, windCanvasLayer = null, windCtx = null;

function initLandGrid(world) {
    if (!world) return;
    const resolution = 8; 
    landGridWidth = 360 * resolution; landGridHeight = 180 * resolution;
    
    const canvas = document.createElement('canvas');
    canvas.width = landGridWidth; canvas.height = landGridHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    const projection = d3.geoEquirectangular().fitSize([landGridWidth, landGridHeight], world);
    ctx.fillStyle = '#FF0000';
    ctx.beginPath();
    d3.geoPath().projection(projection).context(ctx)(world);
    ctx.fill();
    
    const imgData = ctx.getImageData(0, 0, landGridWidth, landGridHeight).data;
    landGrid = new Uint8Array(landGridWidth * landGridHeight);
    for (let i = 0; i < landGrid.length; i++) if (imgData[i * 4] > 100) landGrid[i] = 1;
}

function checkLandFast(lon, lat) {
    if (!landGrid) return false;
    let x = Math.floor((lon + 180) * (landGridWidth / 360));
    let y = Math.floor((90 - lat) * (landGridHeight / 180));
    x = Math.max(0, Math.min(x, landGridWidth - 1));
    y = Math.max(0, Math.min(y, landGridHeight - 1));
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

    if (windCanvasLayer.width / dpr !== width || windCanvasLayer.height / dpr !== height) {
        windCanvasLayer.width = width * dpr; windCanvasLayer.height = height * dpr;
        windCanvasLayer.style.width = `${width}px`; windCanvasLayer.style.height = `${height}px`;
        windCtx.scale(dpr, dpr);
    }
    
    windCtx.clearRect(0, 0, width, height);
    if (!world || !cyclone || cyclone.status !== 'active') return;

    const batchLow = [], batchHigh = [], batchExt = [];
    const GEO_RANGE = 20, GEO_STEP = 0.4, arrowScale = 0.75, headLen = 5;

    for (let lat = Math.floor(cyclone.lat - GEO_RANGE * 0.5); lat <= Math.ceil(cyclone.lat + GEO_RANGE * 0.5); lat += GEO_STEP) {
        if (lat < -90 || lat > 90) continue;
        for (let lon = Math.floor(cyclone.lon - GEO_RANGE); lon <= Math.ceil(cyclone.lon + GEO_RANGE); lon += GEO_STEP) {
            const proj = mapProjection([lon, lat]);
            if (!proj || isNaN(proj[0]) || isNaN(proj[1]) || proj[0] < -20 || proj[0] > width + 20 || proj[1] < -20 || proj[1] > height + 20) continue;

            let vec = getWindVectorAt(lon, lat, currentMonth, cyclone, pressureSystems);
            if (vec.magnitude <= 0) continue;

            const angle = Math.atan2(-vec.v, vec.u); 
            const len = Math.min(20, vec.magnitude * arrowScale);
            const dx = (len / 2) * Math.cos(angle), dy = (len / 2) * Math.sin(angle);
            const p2x = proj[0] + dx, p2y = proj[1] + dy;

            let h1x = p2x, h1y = p2y, h2x = p2x, h2y = p2y;
            if (len > 6) {
                h1x = p2x + headLen * Math.cos(angle + 2.67);
                h1y = p2y + headLen * Math.sin(angle + 2.67);
                h2x = p2x + headLen * Math.cos(angle - 2.67);
                h2y = p2y + headLen * Math.sin(angle - 2.67);
            }

            const targetBatch = vec.magnitude > 50 ? batchExt : (vec.magnitude > 30 ? batchHigh : batchLow);
            targetBatch.push(proj[0] - dx, proj[1] - dy, p2x, p2y, h1x, h1y, h2x, h2y);
        }
    }

    windCtx.lineWidth = 1.2; windCtx.lineCap = 'round'; windCtx.lineJoin = 'round';
    const drawBatch = (batch, color) => {
        if (batch.length === 0) return;
        windCtx.beginPath(); windCtx.strokeStyle = color;
        for (let i = 0; i < batch.length; i += 8) {
            windCtx.moveTo(batch[i], batch[i+1]); windCtx.lineTo(batch[i+2], batch[i+3]);
            windCtx.moveTo(batch[i+4], batch[i+5]); windCtx.lineTo(batch[i+2], batch[i+3]); windCtx.lineTo(batch[i+6], batch[i+7]);
        }
        windCtx.stroke();
    };

    drawBatch(batchLow, "rgba(74, 222, 128, 0.4)");  // green
    drawBatch(batchHigh, "rgba(240, 168, 77, 0.6)"); // amber
    drawBatch(batchExt, "rgba(255, 77, 106, 0.8)");  // accent red
}

export function drawForecastCone(container, mapProjection, pathForecasts) {
    if (!pathForecasts || pathForecasts.length === 0 || !pathForecasts[0].track || pathForecasts[0].track.length < 2) return;

    const forecastSteps = pathForecasts[0].track.length;
    const geoPath = d3.geoPath().projection(mapProjection);
    
    container.selectAll(".forecast-cone-container").remove();
    container.selectAll(".forecast-center-line").remove(); 

    const coneSegments = [], meanTrackCoordinates = []; 
    let lastStepData = null;

    const unwrapLon = (lon, refLon) => {
        let diff = lon - refLon;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return refLon + diff;
    };

    let rawDeathIndex = forecastSteps;
    for (let i = 0; i < forecastSteps; i++) {
        if (d3.mean(pathForecasts.map(f => f.track[i]), p => p[2]) <= 15) {
            rawDeathIndex = i; break;
        }
    }

    let quantizedLimit = 8;
    for (let k of [8, 16, 24]) {
        if (rawDeathIndex >= k) quantizedLimit = k; else break;
    }
    quantizedLimit = Math.min(quantizedLimit, forecastSteps - 1);

    let refLon = pathForecasts[0].track[0][0]; 

    for (let i = 0; i <= quantizedLimit; i++) {
        const pointsAtStep = pathForecasts.map(f => f.track[i]).filter(Boolean);
        if (pointsAtStep.length === 0) continue;

        const unwrappedPoints = pointsAtStep.map(p => [unwrapLon(p[0], refLon), p[1]]);
        const avgLonUnwrapped = d3.mean(unwrappedPoints, p => p[0]);
        const avgLat = d3.mean(pointsAtStep, p => p[1]);
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
            const nextPoints = pathForecasts.map(f => f.track[i+1]).filter(Boolean);
            if (nextPoints.length > 0) {
                angle = Math.atan2(d3.mean(nextPoints, p => p[1]) - avgLat, (d3.mean(nextPoints.map(p => [unwrapLon(p[0], refLon), p[1]]), p => p[0]) - avgLonUnwrapped) * cosL);
            }
        } else if (lastStepData) {
            angle = Math.atan2(avgLat - lastStepData.rawCenter[1], (avgLonUnwrapped - lastStepData.rawCenter[0]) * cosL);
        }

        const normal = angle + Math.PI / 2;
        const normalize = (lon) => { while (lon > 180) lon -= 360; while (lon < -180) lon += 360; return lon; };

        const currentStep = {
            rawCenter: [avgLonUnwrapped, avgLat],
            center: [avgLonNorm, avgLat],
            left: [normalize(avgLonUnwrapped + (radiusDeg * Math.cos(normal) / cosL)), avgLat + (radiusDeg * Math.sin(normal))],
            right: [normalize(avgLonUnwrapped + (radiusDeg * Math.cos(normal + Math.PI) / cosL)), avgLat + (radiusDeg * Math.sin(normal + Math.PI))],
            radiusDeg: radiusDeg
        };

        if (lastStepData) {
            coneSegments.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[lastStepData.left, currentStep.left, currentStep.right, lastStepData.right, lastStepData.left]] }});
        }
        coneSegments.push({ type: "Feature", geometry: createGeoCircle(currentStep.center[0], currentStep.center[1], radiusDeg * 111.32) });
        lastStepData = currentStep;
    }

    const coneGroup = container.append("g").attr("class", "forecast-cone-container").style("opacity", 0.15); 
    coneGroup.selectAll("path").data(coneSegments).enter().append("path").attr("d", geoPath).style("fill", THEME.accent).style("stroke", "none").style("pointer-events", "none");

    if (meanTrackCoordinates.length > 1) {
        container.append("path")
            .datum({ type: "Feature", geometry: { type: "LineString", coordinates: meanTrackCoordinates } })
            .attr("class", "forecast-center-line").attr("d", geoPath) 
            .style("fill", "none").style("stroke", THEME.text).style("stroke-width", 1.5).style("stroke-dasharray", "4, 4").style("pointer-events", "none");
    }

    [8, 16, 24].forEach(idx => {
        if (idx > quantizedLimit) return;
        const step = pathForecasts[0].track[idx];
        if (step) {
            const proj = mapProjection([step[0], step[1]]);
            if (proj) {
                container.append("circle").attr("cx", proj[0]).attr("cy", proj[1]).attr("r", 3).attr("fill", THEME.text);
                container.append("text").attr("x", proj[0]).attr("y", proj[1] - 7).attr("text-anchor", "middle")
                    .style("font-size", "10px").style("font-family", THEME.font).style("fill", THEME.text).text(`+${idx * 3}h`);
            }
        }
    });
}

function drawPressureField(container, mapProjection, pressureSystemsObj) {
    const svgNode = container.node().closest('svg'); 
    const { width, height } = svgNode.getBoundingClientRect();
    const nx = 80, ny = Math.round(nx * height / width), grid = [];
    const systemsLayer = Array.isArray(pressureSystemsObj) ? pressureSystemsObj : (pressureSystemsObj.lower || []);

    for (let j = 0; j < ny; ++j) {
        for (let i = 0; i < nx; ++i) {
            const coords = mapProjection.invert([i * width / nx, j * height / ny]);
            if (!coords || !isFinite(coords[0]) || !isFinite(coords[1])) { grid.push(1012); continue; }
            grid.push(getPressureAt(coords[0], coords[1], systemsLayer));
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
        pathForecasts = [], pressureSystems = [], showPressureField = false, showHumidityField = false,
        showPathForecast = false, showWindRadii = false, showPathPoints = false, showWindField = false,
        siteName = null, siteLon = null, siteLat = null, siteData = null, siteHistory = [], onSiteClick = null,
        isPaused = false, month = 8
    } = options;

    const layerNames = [ "layer-static", "layer-humidity", "layer-pressure", "layer-forecast", "layer-track-lines", "layer-track-points", "layer-wind-radii", "layer-cyclone", "layer-pressure-handles", "track-interaction-layer", "layer-ui" ];
    layerNames.forEach(name => { if (mapSvg.select(`.${name}`).empty()) mapSvg.append("g").attr("class", name); });
    
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
        staticLayer.append("g").attr("class", "land-group").selectAll("path").data(world.features).enter().append("path").attr("class", "land").style("stroke", "none");
    }

    staticLayer.select(".graticule").attr("d", pathGenerator);
    staticLayer.select(".land-group").selectAll(".land").attr("d", pathGenerator);

    if (showWindField && cyclone && cyclone.status === 'active') { drawWindField(mapSvg, mapProjection, cyclone, pressureSystems, world); } 
    else if (windCtx && windCanvasLayer) { windCtx.clearRect(0, 0, windCanvasLayer.width, windCanvasLayer.height); }

    pressureLayer.selectAll("*").remove(); 
    if (showPressureField && cyclone && cyclone.status === 'active') drawPressureField(pressureLayer, mapProjection, pressureSystems);

    humidityLayer.selectAll("*").remove();
    if (showHumidityField && cyclone && cyclone.status === 'active') drawHumidityField(humidityLayer, mapProjection, pressureSystems, cyclone);

    windRadiiLayer.selectAll("*").remove(); 
    if (showWindRadii && cyclone && cyclone.status === 'active') drawWindRadii(windRadiiLayer, pathGenerator, cyclone, pressureSystems, isPaused);

    forecastLayer.selectAll("*").remove();
    if (showPathForecast && pathForecasts && pathForecasts.length > 0) drawForecastCone(forecastLayer, mapProjection, pathForecasts);

    if (cyclone && cyclone.track && cyclone.track.length > 1) {
        const unwrappedTrack = [];
        let lastLon = NaN;
        cyclone.track.forEach(pointData => {
            const point = [...pointData];
            if (!isNaN(lastLon) && Math.abs(point[0] - lastLon) > 180) point[0] += (point[0] < lastLon) ? 360 : -360;
            lastLon = point[0]; unwrappedTrack.push(point);
        });

        const segmentData = [];
        for (let i = 0; i < unwrappedTrack.length - 1; i++) {
            segmentData.push({
                type: "LineString", coordinates: [unwrappedTrack[i].slice(0, 2), unwrappedTrack[i+1].slice(0, 2)],
                intensity: unwrappedTrack[i+1][2], isT: unwrappedTrack[i+1][3], isE: unwrappedTrack[i+1][4], isS: unwrappedTrack[i+1][6]
            });
        }

        trackLineLayer.selectAll(".storm-track").data(segmentData).join(
            enter => enter.append("path").attr("class", "storm-track").attr("d", pathGenerator).style("stroke", d => getCategory(d.intensity, d.isT, d.isE, d.isS).color),
            update => update.attr("d", pathGenerator).style("stroke", d => getCategory(d.intensity, d.isT, d.isE, d.isS).color)
        );

        if (showPathPoints) {
            trackPointLayer.selectAll("circle").data(unwrappedTrack.filter((_, i) => i % 2 === 0)).join(
                enter => enter.append("circle").attr("r", 4.5).attr("stroke", THEME.bg2).attr("stroke-width", 1)
                    .attr("cx", d => mapProjection(d.slice(0, 2))[0]).attr("cy", d => mapProjection(d.slice(0, 2))[1]).style("fill", d => getCategory(d[2], d[3], d[4], d[6]).color),
                update => update.attr("cx", d => mapProjection(d.slice(0, 2))[0]).attr("cy", d => mapProjection(d.slice(0, 2))[1]).style("fill", d => getCategory(d[2], d[3], d[4], d[6]).color)
            );
        } else trackPointLayer.selectAll("*").remove();
    } else {
        trackLineLayer.selectAll("*").remove(); trackPointLayer.selectAll("*").remove();
    }

    if (cyclone && cyclone.status === 'active') {
        cycloneLayer.selectAll("circle").data([cyclone]).join(
            enter => enter.append("circle").attr("r", 7).attr("stroke", "white").attr("stroke-width", 1.5)
                .attr("cx", d => mapProjection([d.lon, d.lat])[0]).attr("cy", d => mapProjection([d.lon, d.lat])[1]).attr("fill", d => getCategory(d.intensity, d.isTransitioning, d.isExtratropical, d.isSubtropical).color),
            update => update.attr("cx", d => mapProjection([d.lon, d.lat])[0]).attr("cy", d => mapProjection([d.lon, d.lat])[1]).attr("fill", d => getCategory(d.intensity, d.isTransitioning, d.isExtratropical, d.isSubtropical).color)
        );
    } else cycloneLayer.selectAll("*").remove();

    pressureHandlesLayer.selectAll("*").remove(); 
    const activeSystemsList = Array.isArray(pressureSystems) ? pressureSystems : (pressureSystems.upper || []);
    if (showPressureField && cyclone && cyclone.status === 'active' && activeSystemsList.length > 0) {
        drawInteractivePressureSystems(pressureHandlesLayer, mapProjection, activeSystemsList.filter(s => Math.abs(s.strength) > 5), pressureSystems, cyclone, options.onSystemRemove);
    }

    uiLayer.selectAll("*").remove();
    if (siteLon != null && siteLat != null && isFinite(siteLon) && isFinite(siteLat)) drawSiteMarker(uiLayer, mapProjection, siteName, siteLon, siteLat, siteData, siteHistory, onSiteClick);
}

function drawSiteMarker(container, projection, name, lon, lat, data, history, onClick) {
    const proj = projection([lon, lat]);
    if (!proj) return;
    const isSelected = data ? data.isSelected : false;
    const markerColor = isSelected ? THEME.text : THEME.bg2;

    container.append("rect")
        .attr("x", proj[0] - 5).attr("y", proj[1] - 5).attr("width", 10).attr("height", 10)
        .attr("fill", markerColor).attr("stroke", THEME.text).attr("stroke-width", 1.5)
        .style("cursor", "pointer").style("pointer-events", "all") 
        .on('mouseover', function() { d3.select(this).attr('fill', THEME.text); })
        .on('mousemove', (e) => e.stopPropagation()) 
        .on('mouseout', function() { d3.select(this).attr('fill', markerColor) })
        .on("click", (e) => { e.stopPropagation(); if (onClick) onClick(); });

    if (name) {
        container.append("text").attr("x", proj[0]).attr("y", proj[1] + 16).attr("class", "site-label-name")
            .style("fill", THEME.text).style("font-weight", "bold").style("font-size", "11px")
            .style("text-anchor", "middle").text(name);
    }
}

export function drawFinalPath(mapSvg, mapProjection, cyclone, world, tooltip, siteName, siteLon, siteLat, showPathPoints = false, finalStats = null, basin = 'WPAC', pressureSystems = [], showWindField = false, month = 8, siteHistory = [], siteData = null, onSiteClick = null) {
    if (!cyclone || !cyclone.track || cyclone.track.length < 2) return;
    mapSvg.select(".layer-track-lines").selectAll(".history-segment").remove();

    const { width, height } = mapSvg.node().getBoundingClientRect();
    const unwrappedTrackForCentering = [];
    let lastLon_center = NaN;
    cyclone.track.forEach(pointData => {
        const point = [...pointData];
        if (!isNaN(lastLon_center) && Math.abs(point[0] - lastLon_center) > 180) point[0] += (point[0] < lastLon_center) ? 360 : -360;
        lastLon_center = point[0]; unwrappedTrackForCentering.push(point);
    });

    const avgLon = d3.mean(unwrappedTrackForCentering, p => p[0]);
    const avgLat = d3.mean(unwrappedTrackForCentering, p => p[1]);

    if (isFinite(avgLon) && isFinite(avgLat)) mapProjection.rotate([-avgLon, -avgLat]).center([0, 0]);

    const leftPad = width > 600 ? 360 : 100; 
    mapProjection.fitExtent([[leftPad, 100], [width - 100, height - 100]], { type: "LineString", coordinates: cyclone.track.map(p => [p[0], p[1]]) });
    
    drawMap(mapSvg, mapProjection, world, { ...cyclone, status: 'history' }, { pathForecasts: [], pressureSystems: pressureSystems, showPressureField: false, showHumidityField: false, showPathForecast: false, showWindRadii: false, siteName, siteLon, siteLat, showPathPoints, showWindField, month, siteHistory, siteData, onSiteClick });

    if (finalStats) {
        const infoBox = document.getElementById('map-info-box');
        if (infoBox) {
            document.getElementById('map-info-time').textContent = finalStats.number; 
            document.getElementById('map-info-intensity').textContent = `${finalStats.peakWind}kt / ${finalStats.minPressure}hPa`;
            document.getElementById('map-info-movement').textContent = `ACE: ${finalStats.ace}`;
            infoBox.classList.remove('hidden');
        }
    } else document.getElementById('map-info-box').classList.add('hidden');

    let interactionLayer = mapSvg.select(".track-interaction-layer");
    let forecastLayer = mapSvg.select(".layer-forecast"); 
    if (forecastLayer.empty()) forecastLayer = mapSvg.insert("g", ".layer-ui").attr("class", "layer-forecast");
    if (interactionLayer.empty()) interactionLayer = mapSvg.insert("g", ".layer-ui").attr("class", "track-interaction-layer");

    interactionLayer.selectAll("*").remove();
    interactionLayer.append("rect").attr("class", "interaction-overlay").attr("width", width).attr("height", height).style("fill", "transparent").style("cursor", "crosshair");

    const highlightCircle = interactionLayer.append("circle").attr("r", 9).style("fill", "none").style("stroke", THEME.text).style("stroke-width", "2px").style("pointer-events", "none").style("opacity", 0);
    const selectedCircle = interactionLayer.append("circle").attr("r", 7).style("fill", THEME.accent).style("fill-opacity", 0.6).style("stroke", "none").style("pointer-events", "none").style("opacity", 0);

    function findClosestPoint(mouseX, mouseY) {
        let closest = null, minDist = Infinity;
        cyclone.track.forEach((data, idx) => {
            const proj = mapProjection(data.slice(0, 2));
            if (!proj) return;
            const dist = Math.hypot(mouseX - proj[0], mouseY - proj[1]);
            if (dist < minDist) { minDist = dist; closest = { data, index: idx }; }
        });
        return minDist < 50 ? closest : null;
    }

    interactionLayer.select(".interaction-overlay").on("mousemove", function(event) {
        const [mouseX, mouseY] = d3.pointer(event);
        const closestPoint = findClosestPoint(mouseX, mouseY);

        if (closestPoint) {
            const { data, index } = closestPoint;
            const [lon, lat, intensity, isT, isE, circulationSize, isS, r34, r50, r64, storedPressure] = data;
            const category = getCategory(intensity, isT, isE, isS);
            const pressure = storedPressure !== undefined ? storedPressure : Math.round(windToPressure(intensity, circulationSize || 250, basin, getPressureAt(lon, lat, pressureSystems)));
            const lonValue = lon > 180 ? lon - 360 : (lon < -180 ? lon + 360 : lon);
            
            tooltip.transition().duration(50).style("opacity", .9);
            tooltip.html(
                `<div style="text-align: center; font-family: ${THEME.font}; font-size: 11px;">
                    <strong style="color: ${THEME.textMuted};">T+${index * 3}h</strong><br/>
                    <span style="color: ${THEME.textDim};">${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lonValue).toFixed(1)}°${lonValue >= 0 ? 'E' : 'W'}</span><br/>
                    <span style="color:${category.color}; font-size:1.1em; font-weight:bold;">${intensity.toFixed(0)}KT / ${pressure}hPa</span><br/>
                    <span style="color: ${THEME.textDim}; font-size: 10px; text-transform: uppercase;">${category.shortName}</span>
                </div>`
            ).style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
            
            const proj = mapProjection(data.slice(0, 2));
            if (proj) highlightCircle.attr("cx", proj[0]).attr("cy", proj[1]).style("fill", category.color).style("opacity", 1);
        } else {
            tooltip.style("opacity", 0); highlightCircle.style("opacity", 0);
        }
    }).on("click", function(event) {
        forecastLayer.selectAll("*").remove(); selectedCircle.style("opacity", 0);
        const closestPoint = findClosestPoint(...d3.pointer(event));
        if (closestPoint) {
            const { data, index } = closestPoint;
            const proj = mapProjection(data.slice(0, 2));
            selectedCircle.attr("cx", proj[0]).attr("cy", proj[1]).style("opacity", 1);

            const snapAge = Math.floor((index * 3) / 6) * 6; 
            if (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) {
                const historicalForecast = cyclone.forecastLogs[snapAge];
                drawForecastCone(forecastLayer, mapProjection, historicalForecast);
            }
            window.dispatchEvent(new CustomEvent('cycloneTrackClick', { detail: { index: index } }));
        } else window.dispatchEvent(new CustomEvent('cycloneTrackDeselect'));
    }).on("mouseleave", function() { tooltip.style("opacity", 0); highlightCircle.style("opacity", 0); });
}

export function drawHistoricalIntensityChart(chartContainer, cycloneTrack, tooltip, mode = 'kt', basin = 'WPAC') {
    chartContainer.selectAll("*").remove();
    if (!cycloneTrack || cycloneTrack.length < 2) return;

    const { width, height } = chartContainer.node().getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const margin = {top: 20, right: 20, bottom: 30, left: 45};
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;
    
    const chartSvg = chartContainer.append("svg").attr("width", width).attr("height", height).append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    
    const intensityData = cycloneTrack.map((point, index) => ({
        hour: index * 3,
        val: mode === 'kt' ? Math.round(point[2]) : (point[10] !== undefined ? point[10] : Math.round(windToPressure(Math.round(point[2]), point[5] || 300, basin))),
        isT: point[3], isE: point[4], isS: point[6]
    }));

    const maxHour = intensityData[intensityData.length - 1].hour;
    const x = d3.scaleLinear().domain([0, maxHour]).range([0, innerWidth]);
    let y;

    if (mode === 'kt') y = d3.scaleLinear().domain([0, Math.max(30, d3.max(intensityData, d => d.val) * 1.05)]).range([innerHeight, 0]).nice();
    else y = d3.scaleLinear().domain([Math.min(1000, d3.min(intensityData, d => d.val) - 5), 1015]).range([innerHeight, 0]).nice();
    
    chartSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${innerHeight})`).style("color", THEME.textMuted).call(d3.axisBottom(x).ticks(Math.min(5, maxHour / 12)).tickFormat(d => `${d}h`));
    chartSvg.append("g").attr("class", "axis").style("color", THEME.textMuted).call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}${mode === 'kt' ? 'kt' : ''}`));

    const lineGen = d3.line().x(d => x(d.hour)).y(d => y(d.val));
    chartSvg.append("path").datum(intensityData).attr("fill", "none").attr("stroke", THEME.accent).attr("stroke-width", 2).attr("d", lineGen);

    const extLineGen = d3.line().x(d => x(d.hour)).y(d => y(d.val)).defined(d => d.isE);
    chartSvg.append("path").datum(intensityData).attr("fill", "none").attr("stroke", "#8e44ad").attr("stroke-width", 2).attr("d", extLineGen);

    const focus = chartSvg.append("g").style("display", "none");
    focus.append("line").attr("y1", 0).attr("y2", innerHeight).attr("stroke", THEME.textMuted).attr("stroke-dasharray", "3,3");
    focus.append("circle").attr("r", 4).attr("fill", THEME.text);

    chartSvg.append("rect").attr("width", innerWidth).attr("height", innerHeight).style("fill", "none").style("pointer-events", "all")
        .on("mouseover", () => { focus.style("display", null); tooltip.style("opacity", .9); })
        .on("mouseout", () => { focus.style("display", "none"); tooltip.style("opacity", 0); })
        .on("mousemove", function(event) {
            const i = d3.bisector(d => d.hour).left(intensityData, x.invert(d3.pointer(event)[0]), 1);
            const d = intensityData[i - 1];
            if (!d) return;

            focus.attr("transform", `translate(${x(d.hour)},${y(d.val)})`);
            const category = getCategory(mode === 'kt' ? d.val : cycloneTrack[i-1][2], d.isT, d.isE, d.isS);
            
            tooltip.html(`
                <div style="text-align: center; font-family: ${THEME.font};">
                    <strong style="color: ${THEME.textDim};">T+${d.hour}h</strong><br/>
                    <span style="color: ${THEME.text}; font-size:1.1em">${d.val}${mode === 'kt' ? 'KT' : 'hPa'}</span><br/>
                    <span style="color:${category.color}; font-weight:bold; font-size:9px">${category.shortName}</span>
                </div>
            `).style("left", (event.pageX + 15) + "px").style("top", (event.pageY - 28) + "px");
        });
}

export function drawAllHistoryTracks(mapSvg, mapProjection, historyList, world) {
    if (!historyList || historyList.length === 0) return;
    [".layer-pressure", ".layer-humidity", ".layer-forecast", ".layer-wind-radii", ".layer-cyclone", ".track-interaction-layer", ".layer-ui", ".layer-pressure-handles"].forEach(s => mapSvg.selectAll(s).selectAll("*").remove());

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
            if (!isNaN(lastUnwrappedLon) && Math.abs(lon - lastUnwrappedLon) > 180) lon += (lon - lastUnwrappedLon > 0) ? -360 : 360;
            if (idx === 0) { while (lon - referenceLon > 180) lon -= 360; while (lon - referenceLon < -180) lon += 360; } 
            else lon += Math.round((lastUnwrappedLon - p[0]) / 360) * 360;
            lastUnwrappedLon = lon;
            minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
            return [lon, p[1], p[2], p[3], p[4], p[5], p[6]];
        });

        for (let i = 0; i < unwrappedTrack.length - 1; i++) {
            allSegments.push({
                type: "Feature", properties: { color: getCategory(unwrappedTrack[i+1][2], unwrappedTrack[i+1][3], unwrappedTrack[i+1][4], unwrappedTrack[i+1][6]).color, name: item.name, intensity: unwrappedTrack[i+1][2] },
                geometry: { type: "LineString", coordinates: [unwrappedTrack[i].slice(0, 2), unwrappedTrack[i+1].slice(0, 2)] }
            });
        }
    });

    const { width, height } = mapSvg.node().getBoundingClientRect();
    mapProjection.rotate([-(minLon + maxLon) / 2, 0]).center([0, (minLat + maxLat) / 2]);
    mapProjection.fitExtent([[50, 50], [width - 50, height - 50]], { type: "LineString", coordinates: [[minLon, minLat], [maxLon, maxLat]] });

    drawMap(mapSvg, mapProjection, world, {status: 'history_all', track: []}, {});

    const trackLineLayer = mapSvg.select(".layer-track-lines");
    trackLineLayer.selectAll("*").remove(); 
    
    trackLineLayer.selectAll(".history-segment").data(allSegments).enter().append("path").attr("class", "history-segment").attr("d", d3.geoPath().projection(mapProjection))
        .style("fill", "none").style("stroke", d => d.properties.color).style("stroke-width", 1.8).style("stroke-opacity", 0.6).style("stroke-linecap", "round")
        .on("mouseover", function(event, d) {
            d3.select(this).style("stroke-opacity", 1.0).style("stroke-width", 4).style("stroke", THEME.text).raise();
            d3.select(".tooltip").transition().duration(50).style("opacity", .9).html(`<div style="text-align:center; font-family:${THEME.font};"><strong>${d.properties.name}</strong><br/><span style="color:${d.properties.color}">${Math.round(d.properties.intensity)} KT</span></div>`).style("left", (event.pageX + 10) + "px").style("top", (event.pageY - 20) + "px");
        })
        .on("mouseout", function(event, d) { 
            d3.select(this).style("stroke-opacity", 0.6).style("stroke-width", 1.8).style("stroke", d.properties.color); 
            d3.select(".tooltip").style("opacity", 0);
        });
}

function drawInteractivePressureSystems(container, mapProjection, renderableSystems, allPressureSystems, cyclone, onRemove) {
    let viewCenterLon = mapProjection.center()[0];
    if (Math.abs(mapProjection.rotate()[0]) > 0.1) viewCenterLon = -mapProjection.rotate()[0];

    const getVisualLon = (dataLon) => {
        let diff = dataLon - viewCenterLon;
        while (diff < -180) diff += 360; while (diff > 180) diff -= 360;
        return viewCenterLon + diff;
    };

    const handles = container.selectAll(".pressure-handle").data(renderableSystems);
    const enterHandles = handles.enter().append("g").attr("class", "pressure-handle").style("cursor", "grab");

    enterHandles.append("circle").attr("class", "halo").attr("r", 20).attr("fill", "none").attr("stroke", d => d.strength > 0 ? "#2980b9" : THEME.accent).attr("stroke-width", 1).attr("opacity", 0.3).style("pointer-events", "none");
    enterHandles.append("circle").attr("class", "core").attr("r", 12).attr("stroke", THEME.text).attr("stroke-width", 1.5).attr("fill-opacity", 0.8);
    enterHandles.append("text").attr("dy", "0.35em").attr("text-anchor", "middle").style("font-family", THEME.font).style("font-weight", "bold").style("font-size", "11px").style("fill", THEME.text).style("pointer-events", "none");

    const allHandles = enterHandles.merge(handles);

    allHandles.on("dblclick", (event, d) => { event.stopPropagation(); event.preventDefault(); if (d.isManual && onRemove) onRemove(d); });
    allHandles.attr("transform", d => {
        const coords = mapProjection([getVisualLon(d.x), d.y]);
        return (!coords || isNaN(coords[0]) || isNaN(coords[1])) ? "translate(-9999, -9999)" : `translate(${coords[0]}, ${coords[1]})`;
    });
    allHandles.select(".core").attr("fill", d => d.strength > 0 ? "#2980b9" : THEME.accent);
    allHandles.select(".halo").attr("stroke", d => d.strength > 0 ? "#2980b9" : THEME.accent);
    allHandles.select("text").text(d => d.strength > 0 ? "H" : "L");

    allHandles.call(d3.drag()
        .subject(function(event, d) { return { x: mapProjection([getVisualLon(d.x), d.y])[0], y: mapProjection([getVisualLon(d.x), d.y])[1] }; })
        .on("start", function() { d3.select(this).style("cursor", "grabbing").select(".core").attr("stroke", THEME.amber).attr("stroke-width", 3); })
        .on("drag", function(event, d) {
            d3.select(this).attr("transform", `translate(${event.x}, ${event.y})`);
            const coords = mapProjection.invert([event.x, event.y]);
            if (coords) {
                const lowerList = Array.isArray(allPressureSystems) ? null : (allPressureSystems.lower || []);
                const dx = coords[0] - d.x, dy = coords[1] - d.y;
                d.x = coords[0]; d.y = coords[1];
                if (lowerList) {
                    const index = (allPressureSystems.upper || []).indexOf(d);
                    if (index !== -1 && lowerList[index]) { lowerList[index].x += dx; lowerList[index].y += dy; }
                }
            }
        })
        .on("end", function(event, d) {
            d3.select(this).style("cursor", "grab").select(".core").attr("stroke", THEME.text).attr("stroke-width", 1.5);
            const svg = d3.select(this.closest("svg"));
            const pressureLayer = svg.select(".layer-pressure");
            if (!pressureLayer.empty()) { pressureLayer.selectAll("*").remove(); drawPressureField(pressureLayer, mapProjection, allPressureSystems); }
            if (cyclone && cyclone.status === 'active') {
                const forecastLayer = svg.select(".layer-forecast");
                if (!forecastLayer.empty()) {
                    forecastLayer.selectAll("*").remove();
                    const newForecasts = generatePathForecasts(cyclone, allPressureSystems, checkLandFast);
                    drawForecastCone(forecastLayer, mapProjection, newForecasts);
                }
            }
        })
    );
    handles.exit().remove();
}

export function renderJTWCStyle(cyclone, timeIndex, worldData) {
    const width = 1600, height = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');

    const unwrapLon = (lon, refLon) => { let diff = lon - refLon; while (diff > 180) diff -= 360; while (diff < -180) diff += 360; return refLon + diff; };
    const centerLon = cyclone.track[timeIndex][0], centerLat = cyclone.track[timeIndex][1];
    const pastTrack = cyclone.track.slice(0, timeIndex + 1).map(p => { const newP = [...p]; newP[0] = unwrapLon(p[0], centerLon); return newP; });
    const currentPoint = pastTrack[timeIndex];

    const snapAge = Math.floor((timeIndex * 3) / 6) * 6; 
    let forecastModels = (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) ? cyclone.forecastLogs[snapAge] : (cyclone.pathForecasts || []);
    forecastModels = forecastModels.map(model => ({ ...model, track: model.track.map(p => { const newP = [...p]; newP[0] = unwrapLon(p[0], centerLon); return newP; }) }));

    const projection = d3.geoEquirectangular().rotate([-centerLon, 0]).center([0, centerLat]).scale(3500).translate([width / 2, height / 2]);
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);

    ctx.fillStyle = THEME.bg0; ctx.fillRect(0, 0, width, height);
    ctx.beginPath(); ctx.strokeStyle = THEME.border; ctx.lineWidth = 1;
    pathGenerator(d3.geoGraticule().step([2, 2])()); ctx.stroke();
    ctx.beginPath(); ctx.fillStyle = THEME.bg2; ctx.strokeStyle = THEME.borderHi; ctx.lineWidth = 1;
    pathGenerator(worldData); ctx.fill(); ctx.stroke();

    const majorCities = [
        { name: "SAIPAN", lon: 145.7, lat: 15.2 }, { name: "MANILA", lon: 120.98, lat: 14.6 }, { name: "TAIPEI", lon: 121.5, lat: 25.05 }, { name: "HONG KONG", lon: 114.17, lat: 22.3 },
        { name: "YAP", lat: 9.51, lon: 138.12 }, { name: "SHANGHAI", lon: 121.47, lat: 31.23 }, { name: "SEOUL", lon: 126.98, lat: 37.56 }, { name: "TOKYO", lon: 139.69, lat: 35.69 },
        { name: "HO CHI MINH", lon: 106.63, lat: 10.82 }, { name: "NAHA", lon: 127.68, lat: 26.21 }, { name: "GUAM", lon: 144.7, lat: 13.4 }, { name: "IWO TO", lon: 141.3, lat: 24.8 },
        { name: "DHAKA", lon: 90.39, lat: 23.73 }, { name: "HONOLULU", lon: -157.86, lat: 21.31 }, { name: "LOS ANGELES", lon: -118.24, lat: 34.05 }, { name: "HAVANA", lon: -82.35, lat: 23.13 },
        { name: "NEW YORK", lon: -74.00, lat: 40.71 }, { name: "HOUSTON", lon: -95.37, lat: 29.76 }, { name: "SAN FRANCISCO", lon: -122.42, lat: 37.77 }, { name: "BRISBANE", lon: 153.02, lat: -27.47 },
        { name: "DARWIN", lon: 130.84, lat: -12.46 }, { name: "CAIRNS", lon: 145.77, lat: -16.92 }
    ];

    ctx.save(); ctx.fillStyle = THEME.textDim; ctx.font = "bold 11px Arial"; ctx.textBaseline = "middle";
    majorCities.forEach(city => {
        const pos = projection([city.lon, city.lat]);
        if (pos && pos[0] > 10 && pos[0] < width - 10 && pos[1] > 10 && pos[1] < height - 10) {
            ctx.fillStyle = THEME.borderHi; ctx.fillRect(pos[0] - 2, pos[1] - 2, 4, 4);
            ctx.fillStyle = THEME.textDim; ctx.textAlign = pos[0] > width - 80 ? "right" : "left";
            ctx.fillText(city.name, pos[0] + (pos[0] > width - 80 ? -5 : 5), pos[1]);
        }
    });
    ctx.restore();

    const boundaryPoints = [], rawSteps = [], meanTrack = [];
    if (forecastModels.length > 0 && forecastModels[0].track.length > 1) {
        let maxRadiusSoFar = 0.02;
        for (let i = 0; i <= Math.min(8, d3.max(forecastModels, m => m.track.length) - 1); i++) {
            const pts = forecastModels.map(m => m.track[i]).filter(Boolean);
            if (pts.length === 0) continue;
            const avgLon = d3.mean(pts, p => p[0]), avgLat = d3.mean(pts, p => p[1]);
            meanTrack.push([avgLon, avgLat]);
            const stdDev = d3.deviation(pts, p => Math.hypot((p[0] - avgLon) * Math.cos(avgLat * Math.PI / 180), p[1] - avgLat)) || 0;
            let radiusDeg = Math.max(maxRadiusSoFar, (0.02 + i * 0.14) + (stdDev * 1.5));
            maxRadiusSoFar = radiusDeg;
            rawSteps.push({ lon: avgLon, lat: avgLat, r: radiusDeg, cosL: Math.cos(avgLat * Math.PI / 180) });
        }
        
        for (let i = 0; i < rawSteps.length; i++) {
            const curr = rawSteps[i], prev = rawSteps[i - 1], next = rawSteps[i + 1];
            let dx = 0, dy = 0;
            if (i === 0 && next) { dx = (next.lon - curr.lon) * curr.cosL; dy = next.lat - curr.lat; } 
            else if (i === rawSteps.length - 1 && prev) { dx = (curr.lon - prev.lon) * curr.cosL; dy = curr.lat - prev.lat; } 
            else if (prev && next) { dx = (next.lon - curr.lon) * curr.cosL + (curr.lon - prev.lon) * curr.cosL; dy = next.lat - curr.lat + curr.lat - prev.lat; }
            if (dx === 0 && dy === 0) { dx = 1; dy = 0; }
            const normal = Math.atan2(dy, dx) + Math.PI / 2;

            const pCenter = projection([curr.lon, curr.lat]), pLeft = projection([curr.lon + (curr.r * Math.cos(normal) / curr.cosL), curr.lat + (curr.r * Math.sin(normal))]), pRight = projection([curr.lon + (curr.r * Math.cos(normal + Math.PI) / curr.cosL), curr.lat + (curr.r * Math.sin(normal + Math.PI))]);
            if (pCenter && pLeft && pRight) boundaryPoints.push({ left: pLeft, right: pRight, center: pCenter, radius: Math.hypot(pLeft[0] - pCenter[0], pLeft[1] - pCenter[1]) });
        }

        const drawConePath = (context) => {
            if (boundaryPoints.length < 2) return;
            context.beginPath(); context.moveTo(boundaryPoints[0].left[0], boundaryPoints[0].left[1]);
            for (let i = 0; i < boundaryPoints.length - 1; i++) context.quadraticCurveTo(boundaryPoints[i].left[0], boundaryPoints[i].left[1], (boundaryPoints[i].left[0] + boundaryPoints[i+1].left[0]) / 2, (boundaryPoints[i].left[1] + boundaryPoints[i+1].left[1]) / 2);
            const lastBP = boundaryPoints[boundaryPoints.length - 1];
            context.lineTo(lastBP.left[0], lastBP.left[1]);
            context.arc(lastBP.center[0], lastBP.center[1], lastBP.radius, Math.atan2(lastBP.left[1] - lastBP.center[1], lastBP.left[0] - lastBP.center[0]), Math.atan2(lastBP.right[1] - lastBP.center[1], lastBP.right[0] - lastBP.center[0]), false);
            for (let i = boundaryPoints.length - 2; i >= 0; i--) context.quadraticCurveTo(boundaryPoints[i+1].right[0], boundaryPoints[i+1].right[1], (boundaryPoints[i+1].right[0] + boundaryPoints[i].right[0]) / 2, (boundaryPoints[i+1].right[1] + boundaryPoints[i].right[1]) / 2);
            context.lineTo(boundaryPoints[0].right[0], boundaryPoints[0].right[1]); context.closePath();
        };

        ctx.save();
        drawConePath(ctx);
        ctx.fillStyle = THEME.accentBg; ctx.fill();
        ctx.strokeStyle = THEME.accent; ctx.lineWidth = 2; ctx.setLineDash([12, 6]); ctx.stroke();
        ctx.restore();

        if (meanTrack.length > 0) {
            ctx.beginPath(); ctx.strokeStyle = THEME.text; ctx.lineWidth = 2;
            pathGenerator({ type: "LineString", coordinates: meanTrack }); ctx.stroke(); ctx.setLineDash([]);
        }
        
        let lastLabelPos = null;
        [12, 24, 36, 48, 72].forEach(h => {
            const idx = h / 3; 
            if (idx > 8) return;
            const pts = forecastModels.map(m => m.track[idx]).filter(Boolean);
            if (pts.length === 0) return;
            const pos = projection([d3.mean(pts, v=>v[0]), d3.mean(pts, v=>v[1])]);
            if (!pos) return;

            let normalAngle = (Math.atan2(d3.mean(pts, v=>v[1]) - currentPoint[1], d3.mean(pts, v=>v[0]) - currentPoint[0])) + Math.PI / 2;
            let labelX = pos[0] + Math.cos(normalAngle) * 145, labelY = pos[1] + Math.sin(normalAngle) * 145;
            if (lastLabelPos && Math.abs(labelY - lastLabelPos.y) < 30) { normalAngle += Math.PI; labelX = pos[0] + Math.cos(normalAngle) * 145; labelY = pos[1] + Math.sin(normalAngle) * 145; }
            lastLabelPos = { x: labelX, y: labelY };

            ctx.beginPath(); ctx.fillStyle = THEME.text; ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.strokeStyle = THEME.textMuted; ctx.lineWidth = 1; ctx.moveTo(pos[0], pos[1]); ctx.lineTo(labelX, labelY); ctx.stroke();

            const cd = new Date(Date.UTC(new Date().getFullYear(), (cyclone.currentMonth || 8) - 1, 1));
            cd.setUTCHours(cd.getUTCHours() + (timeIndex * 3) + h);
            ctx.fillStyle = THEME.text; ctx.font = `bold 20px ${THEME.font}`; ctx.textBaseline = "middle"; ctx.textAlign = labelX > pos[0] ? "left" : "right";
            ctx.fillText(`${labelX > pos[0] ? '  ' : ''}${String(cd.getUTCDate()).padStart(2,'0')}/${String(Math.floor(cd.getUTCHours() / 6) * 6).padStart(2,'0')}Z, ${Math.round(d3.mean(pts, v => v[2]) / 5) * 5}KT${labelX > pos[0] ? '' : '  '}`, labelX, labelY);
        });
    }

    if (pastTrack.length > 0) {
        ctx.beginPath(); ctx.strokeStyle = THEME.textDim; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.setLineDash([4, 2]);
        pathGenerator({ type: "LineString", coordinates: pastTrack.map(p => [p[0], p[1]]) }); ctx.stroke();
    }

    ctx.font = '900 16px "Font Awesome 6 Free"'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    pastTrack.forEach((p, i) => {
        if (i % 2 !== 0) return;
        const pos = projection(p); if (!pos) return;
        ctx.beginPath(); ctx.fillStyle = THEME.bg1; ctx.arc(pos[0], pos[1], 5, 0, Math.PI * 2); ctx.fill();
        if (p[2] >= 64) { ctx.fillStyle = THEME.accent; ctx.fillText('\uf751', pos[0], pos[1]); }
        else if (p[2] >= 34) { ctx.setLineDash([]); ctx.strokeStyle = THEME.amber; ctx.lineWidth = 1.5; ctx.stroke(); }
        else { ctx.strokeStyle = THEME.textDim; ctx.lineWidth = 1.5; ctx.stroke(); }
    });

    [ { kt: 34, color: THEME.green, width: 1.5 }, { kt: 50, color: THEME.amber, width: 2.0 }, { kt: 64, color: THEME.accent, width: 2.5 } ].forEach(cfg => {
        if (currentPoint[2] >= cfg.kt) {
            const radii = Array.isArray(currentPoint[cfg.kt === 64 ? 9 : (cfg.kt === 50 ? 8 : 7)]) ? currentPoint[cfg.kt === 64 ? 9 : (cfg.kt === 50 ? 8 : 7)] : [0,0,0,0].fill((currentPoint[5] / 80) * Math.pow(currentPoint[2] / cfg.kt, 0.6));
            if (radii.every(r => r <= 0)) return;
            const c = projection(currentPoint); if (!c) return;
            ctx.beginPath();
            const rads = radii.map(r => ({ rx: Math.abs(projection([currentPoint[0] + r, currentPoint[1]])[0] - c[0]), ry: Math.abs(projection([currentPoint[0], currentPoint[1] + r])[1] - c[1]) }));
            if (rads[0].rx > 0) ctx.ellipse(c[0], c[1], rads[0].rx, rads[0].ry, 0, -Math.PI/2, 0); else ctx.moveTo(c[0], c[1]);
            if (rads[1].rx > 0) ctx.ellipse(c[0], c[1], rads[1].rx, rads[1].ry, 0, 0, Math.PI/2); else ctx.lineTo(c[0], c[1]);
            if (rads[2].rx > 0) ctx.ellipse(c[0], c[1], rads[2].rx, rads[2].ry, 0, Math.PI/2, Math.PI); else ctx.lineTo(c[0], c[1]);
            if (rads[3].rx > 0) ctx.ellipse(c[0], c[1], rads[3].rx, rads[3].ry, 0, Math.PI, -Math.PI/2); else ctx.lineTo(c[0], c[1]);
            ctx.closePath(); ctx.strokeStyle = cfg.color; ctx.lineWidth = cfg.width; ctx.setLineDash([]); ctx.stroke();
        }
    });

    const currPos = projection(currentPoint);
    if (currPos) {
        ctx.beginPath(); ctx.fillStyle = THEME.accent; ctx.strokeStyle = THEME.bg1; ctx.lineWidth = 2; ctx.arc(currPos[0], currPos[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = THEME.text; ctx.font = `bold 20px ${THEME.font}`; ctx.textAlign = "left";
        ctx.fillText(`${(cyclone.name || "NONAME").toUpperCase()}, ${Math.round(currentPoint[2] / 5) * 5}KT`, currPos[0] + 20, currPos[1] + 10);
    }

    ctx.fillStyle = THEME.bg1; ctx.fillRect(0, 0, width, 50);
    ctx.fillStyle = THEME.text; ctx.font = "bold 20px Arial"; ctx.textAlign = "left";
    ctx.fillText(`BLORF DYNAMICS ENGINE: ${(cyclone.name || 'TD').toUpperCase()} #${timeIndex + 1}`, 20, 32);

    ctx.font = `900 32px ${THEME.font}`; ctx.fillStyle = THEME.textMuted; ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText("** blorf", width - 20, height - 10);

    return canvas;
}

export function renderProbabilitiesStyle(cyclone, timeIndex, worldData, threshold = 34) {
    const width = 1600, height = 1200;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (!cyclone || !cyclone.track) return canvas;

    const safeIndex = (timeIndex >= 0 && timeIndex < cyclone.track.length) ? timeIndex : cyclone.track.length - 1;
    const currentPointRaw = cyclone.track[safeIndex];
    const centerLon = currentPointRaw[0], centerLat = currentPointRaw[1];

    const projection = d3.geoEquirectangular().rotate([-centerLon, 0]).center([0, centerLat]).scale(3500).translate([width / 2, height / 2]);
    const pathGenerator = d3.geoPath().projection(projection).context(ctx);
    const pxPerDeg = projection([1, 0])[0] - projection([0, 0])[0]; 

    ctx.fillStyle = THEME.bg0; ctx.fillRect(0, 0, width, height);
    ctx.beginPath(); ctx.strokeStyle = THEME.border; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); pathGenerator(d3.geoGraticule().step([5, 5])()); ctx.stroke(); ctx.setLineDash([]);

    const snapAge = Math.floor((safeIndex * 3) / 6) * 6;
    let forecasts = (cyclone.forecastLogs && cyclone.forecastLogs[snapAge]) ? cyclone.forecastLogs[snapAge] : cyclone.pathForecasts;

    if (!forecasts || forecasts.length === 0 || !forecasts[0].track || forecasts[0].track.length === 0) {
        ctx.beginPath(); ctx.fillStyle = THEME.bg1; ctx.strokeStyle = THEME.borderHi; pathGenerator(worldData); ctx.fill(); ctx.stroke(); return canvas;
    }

    let realRadiusPx = 16 - 0.2 * threshold;
    const maxRDeg = Math.max(...(currentPointRaw[(threshold === 64) ? 9 : 7] || [0]));
    if (maxRDeg > 0) realRadiusPx = maxRDeg * pxPerDeg * 0.7; 
    else if (currentPointRaw[2] >= threshold) realRadiusPx = (0.5 + (currentPointRaw[2] - threshold) * 0.015) * pxPerDeg * 0.7;

    const gridW = 200, gridH = 150, values = new Float32Array(gridW * gridH).fill(0), track = forecasts[0].track, scaleX = gridW / width, scaleY = gridH / height;

    for (let k = 0; k < track.length - 1; k++) {
        const p1 = track[k], p2 = track[k+1];
        const pos1 = projection([p1[0], p1[1]]), pos2 = projection([p2[0], p2[1]]);
        if (!pos1 || !pos2) continue;

        const distPx = Math.hypot(pos2[0] - pos1[0], pos2[1] - pos1[1]), steps = Math.max(1, Math.ceil(distPx / 15)); 
        for (let s = 0; s < steps; s++) {
            const t = s / steps, px = pos1[0] + (pos2[0] - pos1[0]) * t, py = pos1[1] + (pos2[1] - pos1[1]) * t;
            if (px < 0 || px >= width || py < 0 || py >= height) continue;

            const hour = (k + t) * 3, intensity = p1[2] + (p2[2] - p1[2]) * t;
            let currentRadiusPx = intensity > threshold ? (currentPointRaw[2] > threshold ? realRadiusPx * Math.max(0.5, Math.min(1.5, intensity / currentPointRaw[2])) : (0.5 + (intensity - threshold) * 0.015) * pxPerDeg * 0.7) : 5;

            const jitteredRadius = currentRadiusPx * (1.0 + (Math.sin(hour * 2.5) * 0.1) + ((Math.random() - 0.5) * 0.15));
            const sigmaPx = ((40 + (hour * 5.5)) / 111.32) * pxPerDeg * 0.7; 
            const maxProb = (1.0 / (1.0 + Math.exp(-1.5 * ((intensity - threshold) / (5 + hour * 0.25))))) * Math.max(0.0, 1.0 - (hour / (threshold === 64 ? 150 : 200))) * 100;

            if (maxProb < 1) continue;

            const influenceRad = jitteredRadius + sigmaPx * 2.5, gx = px * scaleX, gy = py * scaleY, gRad = influenceRad * scaleX;
            for (let j = Math.max(0, Math.floor(gy - gRad)); j <= Math.min(gridH - 1, Math.ceil(gy + gRad)); j++) {
                const dy = (j / gridH) * height - py, dy2 = dy * dy, idx = j * gridW;
                for (let i = Math.max(0, Math.floor(gx - gRad)); i <= Math.min(gridW - 1, Math.ceil(gx + gRad)); i++) {
                    let prob = Math.exp(-(Math.max(0, Math.sqrt(Math.pow((i / gridW) * width - px, 2) + dy2) - jitteredRadius)**2) / (2 * sigmaPx * sigmaPx)) * maxProb;
                    if (prob > 3) prob += ((Math.abs(Math.sin((i + k) * 12.9898 + (j + s) * 78.233) * 43758.5453) % 1) - 0.5) * 8.0; 
                    if (prob > values[idx + i]) values[idx + i] = prob;
                }
            }
        }
    }

    const thresholds = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90];
    const colors = ["rgba(0,0,0,0)", "#004d00", "#008000", "#32cd32", "#adff2f", "#ffff00", "#ffa500", "#ff4500", "#ff0000", "#8b0000", "#800080"];
    const contours = d3.contours().size([gridW, gridH]).thresholds(thresholds)(values);
    const contourPath = d3.geoPath().projection(d3.geoTransform({ point: function(x, y) { this.stream.point(x * (width / gridW), y * (height / gridH)); } })).context(ctx);

    contours.forEach((geometry, i) => { ctx.beginPath(); contourPath(geometry); ctx.fillStyle = colors[i + 1] || colors[colors.length - 1]; ctx.fill(); });

    ctx.beginPath(); ctx.fillStyle = THEME.bg2; ctx.strokeStyle = THEME.border; ctx.lineWidth = 1.0; pathGenerator(worldData); ctx.fill(); ctx.stroke();

    const trackCoords = []; let lastL = track[0][0];
    track.forEach(p => { let l = p[0]; while (l - lastL > 180) l -= 360; while (l - lastL < -180) l += 360; lastL = l; trackCoords.push([l, p[1]]); });
    ctx.beginPath(); ctx.strokeStyle = THEME.text; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); pathGenerator({ type: "LineString", coordinates: trackCoords }); ctx.stroke(); ctx.setLineDash([]);

    ctx.fillStyle = THEME.bg1; ctx.fillRect(0, 0, width, 70); ctx.strokeStyle = THEME.borderHi; ctx.lineWidth = 2; ctx.strokeRect(0, 0, width, 70);
    ctx.fillStyle = THEME.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    
    const simDate = new Date(Date.UTC(new Date().getFullYear(), (cyclone.currentMonth || 8) - 1, 1)); simDate.setUTCHours(simDate.getUTCHours() + safeIndex * 3);
    ctx.font = `bold 28px ${THEME.font}`; ctx.fillText(`${threshold} kt Wind Speed Probabilities (${(cyclone.name || "NONAME").toUpperCase()})`, width / 2, 25);
    ctx.font = `20px ${THEME.font}`; ctx.fillText(`For the 72 hours (3.0 days) from ${simDate.toISOString().replace("T", " ").substring(0, 16)}:00`, width / 2, 53);
    ctx.font = `900 32px ${THEME.font}`; ctx.fillStyle = THEME.textMuted; ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText("** blorf", width - 20, height - 10);
    
    const legW = 30, legH = 500, legX = width - 60, legY = (height - legH) / 2;
    ctx.save(); ctx.font = `bold 18px ${THEME.font}`; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.strokeStyle = THEME.borderHi; ctx.lineWidth = 1; ctx.strokeRect(legX, legY, legW, legH);
    for (let i = 1; i < colors.length; i++) {
        const y = legY + legH - (i * legH / (colors.length - 1));
        ctx.fillStyle = colors[i]; ctx.fillRect(legX, y, legW, legH / (colors.length - 1)); ctx.beginPath(); ctx.moveTo(legX, y); ctx.lineTo(legX + legW, y); ctx.stroke();
        ctx.fillStyle = THEME.text; if (thresholds[i-1]) ctx.fillText(thresholds[i-1], legX + legW + 8, y + legH / (colors.length - 1));
    }
    ctx.fillText("99", legX + legW + 8, legY + 10); ctx.restore();

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

    svg.append("g").attr("transform", `translate(0,${height})`).style("color", THEME.textMuted).call(d3.axisBottom(x).ticks(5).tickFormat(d => `+${d}h`));

    let y, color, unit;
    if (type === 'wind') {
        y = d3.scaleLinear().domain([0, Math.max(30, (d3.max(historyData, d => d.wind) || 10) * 1.1)]).range([height, 0]);
        color = THEME.accent; unit = "KT";
    } else {
        y = d3.scaleLinear().domain([d3.min(historyData, d => d.pressure) - 2, d3.max(historyData, d => d.pressure) + 2]).range([height, 0]);
        color = THEME.amber; unit = "hPa";
    }

    svg.append("g").style("color", THEME.textMuted).call(d3.axisLeft(y).ticks(5));

    const line = d3.line().x(d => x(d.hour)).y(d => y(type === 'wind' ? d.wind : d.pressure)).curve(d3.curveLinear); 
    svg.append("path").datum(historyData).attr("fill", "none").attr("stroke", color).attr("stroke-width", 2).attr("d", line);

    if (type === 'wind') {
        const barbGroup = svg.append("g").attr("class", "wind-barbs");
        historyData.filter((d, i) => i % Math.max(1, Math.floor(historyData.length / (width / 40))) === 0).forEach(d => {
            const g = barbGroup.append("g").attr("transform", `translate(${x(d.hour)}, -15) rotate(${Math.atan2(-d.v, d.u) * RAD_TO_DEG}) scale(0.8)`);
            g.append("line").attr("x1", 0).attr("y1", 0).attr("x2", -20).attr("y2", 0).attr("stroke", THEME.textMuted).attr("stroke-width", 1.5);
            let rem = Math.round(d.wind / 5) * 5, pos = -20; 
            while (rem >= 50) { g.append("path").attr("d", `M${pos},0 L${pos+5},-10 L${pos+10},0`).attr("fill", THEME.textMuted); pos += 12; rem -= 50; }
            while (rem >= 10) { g.append("line").attr("x1", pos).attr("y1", 0).attr("x2", pos + 3).attr("y2", -8).attr("stroke", THEME.textMuted).attr("stroke-width", 1.5); pos += 5; rem -= 10; }
            if (rem >= 5) g.append("line").attr("x1", pos).attr("y1", 0).attr("x2", pos + 1.5).attr("y2", -4).attr("stroke", THEME.textMuted).attr("stroke-width", 1.5);
        });
    }

    const focus = svg.append("g").style("display", "none");
    focus.append("line").attr("y1", 0).attr("y2", height).style("stroke", THEME.textMuted).style("stroke-dasharray", "3,3");
    focus.append("circle").attr("r", 4).style("fill", THEME.bg1).style("stroke", color).style("stroke-width", 2);
    const focusText = focus.append("text").attr("x", 0).attr("y", -10).style("fill", THEME.text).style("font-size", "10px").style("font-family", THEME.font).style("font-weight", "bold").style("text-anchor", "middle");

    svg.append("rect").attr("width", width).attr("height", height).style("fill", "none").style("pointer-events", "all")
        .on("mouseover", () => focus.style("display", null)).on("mouseout", () => focus.style("display", "none"))
        .on("mousemove", (event) => {
            const x0 = x.invert(d3.pointer(event)[0]), i = d3.bisector(d => d.hour).left(historyData, x0, 1);
            let d = historyData[i - 1]; if (historyData[i] && x0 - d.hour > historyData[i].hour - x0) d = historyData[i]; if (!d) return;
            const posY = y(type === 'wind' ? d.wind : d.pressure);
            focus.attr("transform", `translate(${x(d.hour)},${posY})`);
            focus.select("line").attr("y1", -posY).attr("y2", height - posY); 
            focusText.text(`T+${d.hour}h: ${Math.round(type === 'wind' ? d.wind : d.pressure)}${unit}`);
            focusText.attr("x", x(d.hour) + 80 > width ? -40 : (x(d.hour) < 40 ? 40 : 0));
        });
}

export function renderPhaseSpace(cyclone, globalTemp = 289) { 
    const width = 800, height = 600, canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    ctx.fillStyle = THEME.bg0; ctx.fillRect(0, 0, width, height);

    const chartX = 60, chartY = 40, chartW = width - chartX - 180, chartH = height - chartY - 50;
    const rawPoints = [];

    cyclone.track.forEach((p, i) => {
        const lat = p[1], lon = p[0], intensity = p[2], isExtra = p[4], isSub = p[6], ageHours = i * 3, sst = getSST(lat, lon, cyclone.currentMonth || 8, globalTemp);
        
        let B = 35.0 - (sst / 1.0); 
        if (!isExtra) {
            B += ((Math.pow(Math.max(0, Math.abs(lat) - 15), 1.8) / 26.0) * (1.0 + ((lat >= 0 ? 1 : -1) * Math.cos(((cyclone.currentMonth || 8) - 1) / 12 * 2 * Math.PI) * 0.3)) * (ageHours < 48 ? Math.pow(ageHours / 48, 1.5) : 1.0)) / (1.0 + 0.0 * Math.pow(intensity / 40, 1.5));
            if (isSub) B = Math.max(B, 15 + Math.random() * 5);
        } else B = 20 + (30 * Math.tanh((Math.abs(lat) - 20) / 15) * (1.0 + (Math.cos(((cyclone.currentMonth || 8) - 1) / 12 * 2 * Math.PI) * (lat>=0?1:-1) * 0.2))); 
        B = Math.max(0, Math.min(60, B + Math.sin(i * 12.9898) * 1.5));

        let Vt = isExtra ? ((intensity * 1.0) - (Math.abs(lat) - 20 * 0.6 * (1 + Math.sin(((cyclone.currentMonth || 8) - 2) / 12 * 2 * Math.PI))) * 4.0 - Math.max(0, (26 - sst) * 2.0)) : ((intensity * 1.4) - (28 - sst) * 10.0) * (isSub ? 0.8 : 1.0) * Math.max(0.3, Math.min(1.1, (sst - 18) / 16));
        rawPoints.push({ x: B, y: Math.max(-150, Vt + Math.sin(i * 2 * 12.9898) * 3.0), isExtra, isSub, intensity, hour: ageHours });
    });

    const dataPoints = rawPoints.map((p, i) => ({ ...p, x: (rawPoints[i-1]?.x || p.x) / 3 + p.x / 3 + (rawPoints[i+1]?.x || p.x) / 3, y: (rawPoints[i-1]?.y || p.y) / 3 + p.y / 3 + (rawPoints[i+1]?.y || p.y) / 3 }));
    const scaleX = val => chartX + ((val - -10) / 70) * chartW, scaleY = val => chartY + chartH - ((val - -150) / 400) * chartH;

    ctx.fillStyle = "#3a2024"; ctx.fillRect(scaleX(-10), scaleY(250), scaleX(10) - scaleX(-10), scaleY(0) - scaleY(250));
    ctx.fillStyle = "#33291e"; ctx.fillRect(scaleX(10), scaleY(250), scaleX(60) - scaleX(10), scaleY(0) - scaleY(250));
    ctx.fillStyle = "#1e2633"; ctx.fillRect(scaleX(-10), scaleY(0), scaleX(60) - scaleX(-10), scaleY(-150) - scaleY(0));

    ctx.lineWidth = 1; ctx.strokeStyle = THEME.border; ctx.font = `10px ${THEME.font}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = -150; v <= 250; v += 50) { ctx.beginPath(); ctx.moveTo(chartX, scaleY(v)); ctx.lineTo(chartX + chartW, scaleY(v)); ctx.stroke(); ctx.fillStyle = THEME.textMuted; ctx.fillText(v, chartX - 5, scaleY(v)); }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let b = 0; b <= 60; b += 10) { ctx.beginPath(); ctx.moveTo(scaleX(b), chartY); ctx.lineTo(scaleX(b), chartY + chartH); ctx.stroke(); ctx.fillStyle = THEME.textMuted; ctx.fillText(b, scaleX(b), chartY + chartH + 5); }

    ctx.strokeStyle = THEME.textDim; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(scaleX(10), chartY); ctx.lineTo(scaleX(10), chartY + chartH); ctx.stroke(); ctx.beginPath(); ctx.moveTo(chartX, scaleY(0)); ctx.lineTo(chartX + chartW, scaleY(0)); ctx.stroke();

    ctx.font = `bold 12px ${THEME.font}`; ctx.textAlign = "left"; ctx.fillStyle = THEME.accent; ctx.fillText("DEEP WARM CORE", chartX + 10, chartY + 15); ctx.textAlign = "right"; ctx.fillStyle = THEME.amber; ctx.fillText("SHALLOW WARM / HYBRID", chartX + chartW - 10, chartY + 15); ctx.fillStyle = "#3b82f6"; ctx.fillText("COLD CORE (EXTRATROPICAL)", chartX + chartW - 10, chartY + chartH - 15);

    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = 3;
    for (let i = 0; i < dataPoints.length - 1; i++) {
        ctx.beginPath(); ctx.moveTo(scaleX(dataPoints[i].x), scaleY(dataPoints[i].y)); ctx.lineTo(scaleX(dataPoints[i+1].x), scaleY(dataPoints[i+1].y));
        ctx.strokeStyle = dataPoints[i+1].y < 0 ? "#3b82f6" : (dataPoints[i+1].x > 10 ? THEME.amber : THEME.accent); 
        ctx.stroke();
        if (i > 0 && i % 8 === 0) { ctx.fillStyle = THEME.text; ctx.beginPath(); ctx.arc(scaleX(dataPoints[i].x), scaleY(dataPoints[i].y), 2.5, 0, Math.PI*2); ctx.fill(); ctx.font = `9px ${THEME.font}`; ctx.fillText(`D${Math.floor(i / 8)}`, scaleX(dataPoints[i].x) + 6, scaleY(dataPoints[i].y) - 6); }
    }

    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillStyle = THEME.textMuted; ctx.font = `bold 12px ${THEME.font}`; ctx.fillText("CURRENT STATUS", chartX + chartW + 20, chartY);
    ctx.fillStyle = dataPoints[dataPoints.length - 1].y < 0 ? "#3b82f6" : (dataPoints[dataPoints.length - 1].x > 10 ? THEME.amber : THEME.accent); ctx.fillRect(chartX + chartW + 20, chartY + 20, 4, 35);
    ctx.fillStyle = THEME.text; ctx.font = `bold 20px ${THEME.font}`; ctx.fillText(dataPoints[dataPoints.length - 1].y < 0 ? "COLD CORE" : (dataPoints[dataPoints.length - 1].x > 10 ? "SUBTROPICAL" : "TROPICAL"), chartX + chartW + 30, chartY + 20);
    ctx.textAlign = "right"; ctx.fillStyle = THEME.textMuted; ctx.font = `900 32px ${THEME.font}`; ctx.textBaseline = "bottom"; ctx.fillText("** blorf", width - 10, height - 10);

    return canvas;
}

export function startNewsAnimation(canvas, worldData, cyclone, pathForecasts, basin, simulationCount, pressureSystems, currentMonth, globalTemp, globalShear) {
    const ctx = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
    if (!cyclone.track || cyclone.track.length === 0) return null;

    const unwrapLon = (lon, refLon) => { let diff = lon - refLon; while (diff > 180) diff -= 360; while (diff < -180) diff += 360; return refLon + diff; };
    const refLon = cyclone.track[0][0], fullTrackUnwrapped = cyclone.track.map(p => [unwrapLon(p[0], refLon), p[1], p[2]]);
    let forecastModels = pathForecasts ? pathForecasts.map(model => ({ ...model, track: model.track.map(p => [unwrapLon(p[0], refLon), p[1], p[2]]) })) : [];

    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    [...fullTrackUnwrapped, ...forecastModels.flatMap(m => m.track)].forEach(p => { if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0]; if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1]; });

    const projection = d3.geoEquirectangular().rotate([-(minLon + maxLon) / 2, 0]).center([0, (minLat + maxLat) / 2]).translate([width / 2, height / 2]).scale(Math.min((width - 350) / (Math.max(10, maxLon - minLon) * Math.PI / 180), (height - 350) / (Math.max(8, maxLat - minLat) * Math.PI / 180)));
    
    const bgCanvas = document.createElement('canvas'); bgCanvas.width = width; bgCanvas.height = height;
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.fillStyle = THEME.bg0; bgCtx.fillRect(0, 0, width, height); bgCtx.fillStyle = THEME.bg2; bgCtx.strokeStyle = THEME.borderHi; bgCtx.lineWidth = 1.5; d3.geoPath().projection(projection).context(bgCtx)(worldData); bgCtx.fill(); bgCtx.stroke();

    let boundaryPoints = [], animState = 'LOOP', frame = 0, zoomFrame = 0, loopCount = 0, particles = [], animationId = null;
    const totalFrames = 180 + 60 + 540, zoomDuration = 120, maxZoomScale = 2.5, lastTrackPoint = fullTrackUnwrapped[fullTrackUnwrapped.length - 1], initialCycloneScreenPos = projection(lastTrackPoint);

    if (forecastModels.length > 0) {
        for (let i = 0; i < d3.max(forecastModels, m => m.track.length); i++) {
            const pts = forecastModels.map(m => m.track[i]).filter(Boolean); if (pts.length === 0) continue;
            const avgLon = d3.mean(pts, p => p[0]), avgLat = d3.mean(pts, p => p[1]), radiusDeg = Math.max(0.2, (0.05 + i * 0.12) + ((d3.deviation(pts, p => Math.hypot((p[0] - avgLon) * Math.cos(avgLat * Math.PI / 180), p[1] - avgLat)) || 0) * 1.5));
            const pCenter = projection([avgLon, avgLat]), pLeft = projection([avgLon + (radiusDeg / Math.cos(avgLat * Math.PI / 180)), avgLat]), pRight = projection([avgLon - (radiusDeg / Math.cos(avgLat * Math.PI / 180)), avgLat]);
            if (pCenter && pLeft && pRight) boundaryPoints.push({ left: pLeft, right: pRight, center: pCenter, radius: Math.hypot(pLeft[0]-pCenter[0], pLeft[1]-pCenter[1]) });
        }
    }

    const initParticle = (p) => { p.x = Math.random() * width; p.y = Math.random() * height; p.age = Math.random() * 50; p.maxAge = 60 + Math.random() * 60; return p; };

    const render = () => {
        ctx.clearRect(0, 0, width, height);

        if (animState === 'LOOP') {
            ctx.drawImage(bgCanvas, 0, 0);
            let forecastAlpha = frame > 180 ? Math.min(1, (frame - 180) / 60) : 0;

            if (boundaryPoints.length >= 2 && forecastAlpha > 0) {
                ctx.save(); ctx.globalAlpha = forecastAlpha; ctx.beginPath(); ctx.moveTo(boundaryPoints[0].left[0], boundaryPoints[0].left[1]);
                for (let i = 1; i < boundaryPoints.length; i++) ctx.lineTo(boundaryPoints[i].left[0], boundaryPoints[i].left[1]);
                ctx.arc(boundaryPoints[boundaryPoints.length - 1].center[0], boundaryPoints[boundaryPoints.length - 1].center[1], boundaryPoints[boundaryPoints.length - 1].radius, 0, Math.PI, false);
                for (let i = boundaryPoints.length - 2; i >= 0; i--) ctx.lineTo(boundaryPoints[i].right[0], boundaryPoints[i].right[1]);
                ctx.fillStyle = THEME.accentBg; ctx.fill(); ctx.strokeStyle = THEME.accent; ctx.lineWidth = 1; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.restore();
            }

            const currentIndex = Math.floor((fullTrackUnwrapped.length - 1) * Math.min(1, frame / 180));
            if (fullTrackUnwrapped.length > 0) {
                ctx.beginPath(); ctx.strokeStyle = THEME.text; ctx.lineWidth = 4; ctx.lineCap = "round"; ctx.lineJoin = "round";
                for (let i = 0; i < currentIndex; i++) { const p1 = projection(fullTrackUnwrapped[i]), p2 = projection(fullTrackUnwrapped[i+1]); if (p1 && p2) { ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); } }
                ctx.stroke();
                const headProj = projection(fullTrackUnwrapped[currentIndex]);
                if (headProj) {
                    ctx.beginPath(); ctx.fillStyle = THEME.accentBg; ctx.arc(headProj[0], headProj[1], 30 + Math.sin(frame * 0.2) * 5, 0, Math.PI*2); ctx.fill();
                    ctx.font = '900 32px "Font Awesome 6 Free"'; ctx.fillStyle = THEME.accent; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    ctx.save(); ctx.translate(headProj[0], headProj[1]); ctx.rotate(frame * 0.1 * (cyclone.lat < 0 ? 1 : -1)); ctx.fillText('\uf751', 0, 0); ctx.restore();
                }
            }

            if (++frame > totalFrames) { frame = 0; if (++loopCount >= 4) { animState = 'ZOOM'; zoomFrame = 0; } }

        } else if (animState === 'ZOOM') {
            const t = zoomFrame / zoomDuration < .5 ? 2 * (zoomFrame / zoomDuration) ** 2 : -1 + (4 - 2 * (zoomFrame / zoomDuration)) * (zoomFrame / zoomDuration);
            ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(1 + (maxZoomScale - 1) * t, 1 + (maxZoomScale - 1) * t); ctx.translate(-((width / 2) * (1 - t) + initialCycloneScreenPos[0] * t), -((height / 2) * (1 - t) + initialCycloneScreenPos[1] * t));
            ctx.drawImage(bgCanvas, 0, 0);
            ctx.beginPath(); ctx.fillStyle = THEME.accentBg; ctx.arc(initialCycloneScreenPos[0], initialCycloneScreenPos[1], 30 + Math.sin(Date.now() * 0.005) * 5, 0, Math.PI*2); ctx.fill();
            ctx.font = '900 32px "Font Awesome 6 Free"'; ctx.fillStyle = THEME.accent; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.save(); ctx.translate(initialCycloneScreenPos[0], initialCycloneScreenPos[1]); ctx.rotate((Date.now() / 1000) * (cyclone.lat < 0 ? 1 : -1)); ctx.fillText('\uf751', 0, 0); ctx.restore(); ctx.restore();
            if (++zoomFrame > zoomDuration) { animState = 'STREAMLINE'; for(let k=0; k<1500; k++) particles.push(initParticle({})); }

        } else if (animState === 'STREAMLINE') {
            ctx.drawImage(bgCanvas, 0, 0); ctx.lineWidth = 1.2; ctx.lineCap = "round";
            for (let i = 0; i < particles.length; i++) {
                const p = particles[i], geo = projection.invert([p.x, p.y]);
                if (!geo) { initParticle(p); continue; }
                const vec = getWindVectorAt(geo[0], geo[1], currentMonth, cyclone, pressureSystems, globalTemp, globalShear);
                p.x += vec.u * 0.2; p.y -= vec.v * 0.2; p.age++;
                ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - vec.u * 0.6, p.y + vec.v * 0.6);
                ctx.strokeStyle = vec.magnitude > 48 ? `rgba(255, 77, 106, ${p.age < 15 ? p.age / 15 : (p.age > p.maxAge - 15 ? (p.maxAge - p.age) / 15 : 0.5)})` : THEME.textMuted; ctx.stroke();
                if (p.age >= p.maxAge || p.x < 0 || p.x > width || p.y < 0 || p.y > height) initParticle(p);
            }
        }
        animationId = requestAnimationFrame(render);
    };

    render();
    return () => { if (animationId) cancelAnimationFrame(animationId); };
}