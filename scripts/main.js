/**
 * main.js
 * Handles state management, event routing, and module coordination
 */

import { getCategory, knotsToKph, knotsToMph, windToPressure, directionToCompass, getSST, calculateDistance, NAME_LISTS, getPressureAt } from './utils.js';
import { RadarRenderer, calculateRadarDbz, getShaderWindVector } from './radar-system.js';
import { DopplerRenderer } from './radar-doppler.js';
import { initSatelliteView, updateSatelliteView, resetSatelliteParams, setSatelliteGrayscale, getSatelliteSnapshot } from './satellite-view.js';
import { initTerrainSystem, getElevationAt, getLandStatus } from './terrain-data.js';
import { initializeCyclone, initializePressureSystems, updatePressureSystems, updateFrontalZone, updateCycloneState, getWindVectorAt } from './cyclone-model.js';
import { generatePathForecasts } from './forecast-models.js';
import { drawMap, drawFinalPath, drawHistoricalIntensityChart, drawHumidityField, calculateBackgroundHumidity, calculateTotalHumidity, drawAllHistoryTracks, renderJTWCStyle, renderProbabilitiesStyle, drawStationGraph, renderPhaseSpace, startNewsAnimation, renderStationSynopticChart } from './visualization.js';
import { playClick, playToggleOn, playToggleOff, playStart, playError, playAlert, playUpgradeSound, playCat5Sound, toggleSFX } from './audio.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

let lastSiteLatForTide = null;
let cachedLatFactor = 1.0;

const lastRadarState = {
    age: -1,
    siteLon: null,
    siteLat: null,
    cx: -1,
    cy: -1,
    radiusPx: -1,
    mode: null
};

const checkLandWrapper = (lon, lat) => {
    const status = getLandStatus(lon, lat);
    return status.isLand;
};

document.addEventListener('DOMContentLoaded', () => {

    // DOM elements & global state
    const generateButton = document.getElementById('generateButton');
    const pauseButton = document.getElementById('pauseButton');
    const catButton = document.getElementById('catButton');
    const newsModal = document.getElementById('newsModal');
    const closeNewsModal = document.getElementById('closeNewsModal');
    const newsCanvas = document.getElementById('newsCanvas');
    let stopNewsAnimation = null;
    const helpButton = document.getElementById('helpButton');
    const helpModal = document.getElementById('helpModal');
    const closeHelpModal = document.getElementById('closeHelpModal');
    const sfxButton = document.getElementById('sfxButton');
    const sfxIcon = sfxButton.querySelector('i');
    const irBwCheckbox = document.getElementById('irBwCheckbox');
    const basinSelector = document.getElementById('basinSelector');
    const monthSelector = document.getElementById('monthSelector');
    const leftContent = document.getElementById('left-hud-content');
    let selectedHistoryPointIndex = -1;
    const generateJTWCButton = document.getElementById('generateJTWCButton');
    const jtwcModal = document.getElementById('jtwcModal');
    const jtwcOutput = document.getElementById('jtwcOutput');
    const closeJtwcModal = document.getElementById('closeJtwcModal');
    const saveJtwcImage = document.getElementById('saveJtwcImage');
    let isLeftPanelCollapsed = false;
    let chartMode = 'kt';
    const tabKt = document.getElementById('tab-kt');
    const tabHpa = document.getElementById('tab-hpa');
    const togglePressureButton = document.getElementById('togglePressureButton');
    const toggleHumidityButton = document.getElementById('toggleHumidityButton');
    const toggleWindFieldButton = document.getElementById('toggleWindFieldButton');
    const toggleWindRadiiButton = document.getElementById('toggleWindRadiiButton');
    const windRadiiLegend = document.getElementById('wind-radii-legend');
    const radarLegend = document.getElementById('radar-legend');
    const dopplerLegend = document.getElementById('doppler-legend');
    const togglePathButton = document.getElementById('togglePathButton');
    const copyTrackButton = document.getElementById('copy-track-button');
    const downloadTrackButton = document.getElementById('download-track-button');
    const historyButton = document.getElementById('toggleHistoryButton');
    const historyModal = document.getElementById('historyModal');
    const historyHeader = historyModal.querySelector('.border-b') || historyModal.querySelector('.blorf-modal-header');
    const closeHistoryModal = document.getElementById('closeHistoryModal');
    const historyList = document.getElementById('historyList');
    const bestTrackContainer = document.getElementById('best-track-container');
    const bestTrackData = document.getElementById('best-track-data');
    const historyBestTrackContainer = document.getElementById('history-best-track-container');
    const historyBestTrackData = document.getElementById('history-best-track-data');
    const downloadHistoryTrackButton = document.getElementById('downloadHistoryTrackButton');
    const mapContainer = d3.select("#map-container");
    const chartContainer = d3.select("#intensity-chart-container");
    const forecastContainer = document.getElementById('intensity-chart-section');
    const tooltip = d3.select("body").append("div").attr("class", "tooltip");

    const settingsButton = document.getElementById('settingsButton');
    const settingsMenu = document.getElementById('settingsMenu');
    const musicButton = document.getElementById('musicButton');
    const musicMenu = document.getElementById('musicMenu');
    const musicListContainer = document.getElementById('musicListContainer');
    const bgmVolumeSlider = document.getElementById('bgmVolume');
    const bgmAudio = document.getElementById('bgmAudio');
    const globalTempSlider = document.getElementById('globalTempSlider');
    const globalTempValue = document.getElementById('globalTempValue');
    const globalShearSlider = document.getElementById('globalShearSlider');
    const globalShearValue = document.getElementById('globalShearValue');
    const siteNameInput = document.getElementById('siteNameInput');
    const siteLonInput = document.getElementById('siteLonInput');
    const siteLatInput = document.getElementById('siteLatInput');
    const customLonInput = document.getElementById('customLonInput');
    const customLatInput = document.getElementById('customLatInput');
    const showPathPointsCheckbox = document.getElementById('showPathPointsCheckbox');

    const savedSiteName = localStorage.getItem('tcs_site_name');
    const savedSiteLon = localStorage.getItem('tcs_site_lon');
    const savedSiteLat = localStorage.getItem('tcs_site_lat');
    const stats = new Stats();

    const musicTracks = [
        "WPAC - Barotropic.m4a",
        "NATL - Static.m4a",
        "EPAC - Void.m4a",
        "NIO - MayDay.m4a",
        "SIO - Westerlies.m4a",
        "SATL - Serendipity Land.m4a",
    ];

    let currentTrackIndex = -1;
    stats.showPanel(0);
    stats.dom.style.position = 'absolute';
    stats.dom.style.top = '0px';
    stats.dom.style.right = '0px';
    if(bgmAudio) bgmAudio.volume = 0.4;

    let radarRenderer = null;
    let dopplerRenderer = null;
    let radarOverlayCtx = null;
    let radarOverlayCanvas = null;
    let radarScopeVisible = false;
    const savedIrBw = localStorage.getItem('tcs_ir_bw') === 'true';

    if (irBwCheckbox) {
        irBwCheckbox.checked = savedIrBw;
        setSatelliteGrayscale(savedIrBw);
        irBwCheckbox.addEventListener('change', (e) => {
            const isEnabled = e.target.checked;
            setSatelliteGrayscale(isEnabled);
            if (typeof playClick === 'function') playClick();
            localStorage.setItem('tcs_ir_bw', isEnabled);
        });
    }

    if (historyHeader) {
        const btnContainer = document.createElement('div');
        btnContainer.className = "flex gap-2 ml-auto mr-4";

        const showAllBtn = document.createElement('button');
        showAllBtn.innerHTML = '<i class="fa-solid fa-earth-asia"></i> SHOW ALL';
        showAllBtn.className = "text-[10px] font-bold bg-cyan-900/50 hover:bg-cyan-700 text-cyan-300 border border-cyan-500/30 px-3 py-1 rounded transition-colors uppercase tracking-wider";

        showAllBtn.addEventListener('click', () => {
            if (state.history.length === 0) {
                alert("No historical track to display :(");
                return;
            }

            historyModal.classList.add('hidden');
            if (state.simulationInterval) clearInterval(state.simulationInterval);
            state.isPaused = false;

            document.getElementById('satellite-window').classList.add('hidden');
            const restoreBtn = document.getElementById('restore-sat-btn');
            if(restoreBtn) restoreBtn.classList.add('hidden');
            document.getElementById('info-panel').classList.add('hidden');
            document.getElementById('map-info-box').classList.add('hidden');
            document.getElementById('best-track-container').classList.add('hidden');
            forecastContainer.classList.add('hidden');

            drawAllHistoryTracks(mapSvg, mapProjection, state.history, state.world);
        });

        const closeBtn = document.getElementById('closeHistoryModal');
        historyHeader.insertBefore(showAllBtn, closeBtn);
    }

    // animation Loop for WebGL radars & stats
    function animate() {
        const radarVisible = state.radarMode || state.dopplerMode;

        if (radarVisible) {
            stats.begin();
            drawRadarScope();
            radarScopeVisible = true;
            stats.end();
        } else if (radarScopeVisible) {
            if (radarCanvas) {
                radarCanvas.classList.add('hidden');
            }
            if (radarOverlayCanvas) {
                radarOverlayCanvas.classList.add('hidden');
                if (radarOverlayCtx) {
                    radarOverlayCtx.clearRect(0, 0, radarOverlayCanvas.width, radarOverlayCanvas.height);
                }
            }
            // reset radar rendering caches
            lastRadarState.mode = null;
            radarScopeVisible = false;
        }
        requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);

    let state = {
        simulationInterval: null,
        isPaused: false,
        showIntensityChart: true,
        hasAlerted: false,
        hasTriggeredCat1News: false,
        hasTriggeredCat5News: false,
        simulationSpeed: 200,
        cyclone: {},
        selectedHistoryCyclone: null,
        pressureSystems: { upper: [], lower: [] },
        pressureHistory: [],
        frontalZone: {},
        pathForecasts: [],
        currentMonth: 7,
        world: null,
        showPressureField: false,
        showHumidityField: false,
        showPathForecast: false,
        showWindRadii: false,
        GlobalShear: 100,
        GlobalTemp: 289,
        siteName: savedSiteName || '',
        siteLon: savedSiteLon ? parseFloat(savedSiteLon) : null,
        siteLat: savedSiteLat ? parseFloat(savedSiteLat) : null,
        radarMode: false,
        dopplerMode: false,
        customLon: null,
        customLat: null,
        showPathPoints: false,
        showWindField: false,
        history: [],
        simulationCount: 1,
        nextNameIndex: 0,
        selectedHistoryTrackData: '',
        lastFinalStats: null,
        currentSiteData: null,
        siteHistory: [],
        isSiteSelected: false,
        idleRotation: Math.random() * 50,

        cachedSiteLon: null,
        cachedSiteLat: null,
        cachedSiteFriction: 1.0,
        cachedHumidity: 0.7
    };

    let mapSvg, mapProjection;
    let radarCanvas, radarCtx;
    if (savedSiteName) siteNameInput.value = savedSiteName;
    if (savedSiteLon) siteLonInput.value = savedSiteLon;
    if (savedSiteLat) siteLatInput.value = savedSiteLat;
    generateButton.disabled = true;

    // init & setup
    function getEnglishCategoryName(knots, isExtra, isSub, basin) {
        if (isExtra) return "EXTRATROPICAL CYCLONE";
        if (isSub) return "SUBTROPICAL STORM";
        if (knots < 34) return "TROPICAL DEPRESSION";
        if (knots < 64) return "TROPICAL STORM";

        let term = "TYPHOON";
        if (['EPAC', 'NATL', 'SATL'].includes(basin)) {
            term = "HURRICANE";
        } else if (['SHEM', 'SIO', 'NIO'].includes(basin)) {
            term = "CYCLONE";
        }

        if (knots < 83) return `${term} (CAT 1)`;
        if (knots < 96) return `${term} (CAT 2)`;
        if (knots < 113) return `${term} (CAT 3)`;

        return `SUPER ${term} (CAT ${knots < 137 ? '4' : '5'})`;
    }

    initSatelliteView('satCanvas');

    function setupCanvases() {
        mapContainer.select("svg").remove();
        mapSvg = mapContainer.insert("svg", ":first-child")
            .attr("width", "100%")
            .attr("height", "100%")
            .style("z-index", "10")
            .style("pointer-events", "none");

        const { width, height } = mapContainer.node().getBoundingClientRect();
        let initLon = 120, initLat = 15;
        if (typeof state !== 'undefined' && state.siteLon != null && state.siteLat != null) {
            initLon = state.siteLon;
            initLat = state.siteLat;
        } else if (typeof savedSiteLon !== 'undefined' && savedSiteLon) {
            initLon = parseFloat(savedSiteLon);
            initLat = parseFloat(savedSiteLat);
        }

        mapProjection = d3.geoEquirectangular()
            .scale(height / (20 * Math.PI / 180))
            .translate([width / 2, height / 2])
            .center([initLon, initLat]);

        if (!document.getElementById('interaction-fix-style')) {
            const style = document.createElement('style');
            style.id = 'interaction-fix-style';
            style.textContent = `
                .track-interaction-layer,
                .layer-pressure-handles,
                .layer-ui,
                .layer-ui rect,
                .pressure-handle {
                    pointer-events: auto !important;
                    cursor: pointer;
                }
                .interaction-overlay {
                    pointer-events: auto !important;
                }
            `;
            document.head.appendChild(style);
        }

        radarCanvas = document.getElementById('radar-canvas-layer');
        if (radarCanvas) {
            radarCanvas.style.pointerEvents = 'none';
            if (!radarRenderer) {
                radarCanvas.width = 256;
                radarCanvas.height = 256;
                radarCanvas.style.opacity = "0.65";
                radarRenderer = new RadarRenderer(radarCanvas);
            }
            if (!dopplerRenderer) {
                dopplerRenderer = new DopplerRenderer(radarCanvas);
            }
        }

        if (!radarOverlayCanvas) {
            radarOverlayCanvas = document.getElementById('radar-overlay-layer');
            if (!radarOverlayCanvas) {
                radarOverlayCanvas = document.createElement('canvas');
                radarOverlayCanvas.id = 'radar-overlay-layer';
                radarOverlayCanvas.className = "absolute top-0 left-0 w-full h-full pointer-events-none z-30 hidden";
                document.getElementById('map-container').appendChild(radarOverlayCanvas);
            }
            radarOverlayCtx = radarOverlayCanvas.getContext('2d');
        }

        if (radarOverlayCanvas) {
            radarOverlayCanvas.style.pointerEvents = 'none';
            radarOverlayCanvas.width = width;
            radarOverlayCanvas.height = height;
        }
    }

    d3.json("scripts/world-f.json").then(data => {
        state.world = topojson.feature(data, data.objects.collection);
        setupCanvases();
        if (mapProjection && mapProjection.precision) {
            mapProjection.precision(3.1);
        }

        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = './scripts/elevation_1080x540.png';

        img.onload = () => {
            initTerrainSystem(img.src, state.world).then(() => {
                generateButton.disabled = false;
            });
            if (radarRenderer) radarRenderer.loadTerrainTexture(img);
            if (dopplerRenderer) dopplerRenderer.loadTerrainTexture(img);
        };

        drawMap(mapSvg, mapProjection, state.world, {status: null, track: []}, {
            pressureSystems: state.pressureSystems,
            showPressureField: state.showPressureField,
            showHumidityField: state.showHumidityField,
            showPathForecast: state.showPathForecast,
            showWindRadii: state.showWindRadii,
            siteName: state.siteName,
            siteLon: state.siteLon,
            siteLat: state.siteLat,
            showPathPoints: state.showPathPoints,
            showWindField: state.showWindField
        });
    });

    function toggleLeftPanel() {
        if (!leftContent) return;
        isLeftPanelCollapsed ? playToggleOn() : playToggleOff();
        isLeftPanelCollapsed = !isLeftPanelCollapsed;

        if (isLeftPanelCollapsed) {
            leftContent.style.width = '0px';
            leftContent.style.opacity = '0';
            leftContent.style.paddingRight = '0';
        } else {
            leftContent.style.width = '';
            leftContent.style.opacity = '100';
            leftContent.style.paddingRight = '';
        }
    }

    function updateTabUI() {
        [tabKt, tabHpa].forEach(btn => {
            btn.classList.remove('bg-cyan-600', 'text-white');
            btn.classList.add('text-slate-400');
        });
        const activeBtn = chartMode === 'kt' ? tabKt : tabHpa;
        activeBtn.classList.remove('text-slate-400');
        activeBtn.classList.add('bg-cyan-600', 'text-white');
    }

    function downloadMapImage(elementId, filename = 'cyclone_map.png') {
        const captureElement = document.getElementById(elementId);
        if (!captureElement) return;

        let peakWind = 0;
        let minPressure = 1010;
        const currentBasin = basinSelector.value || 'WPAC';
        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basinCode = basinMap[currentBasin] || 'XX';

        const cycloneNum = state.lastFinalStats ? state.lastFinalStats.number.split(' ')[1] : String(state.simulationCount).padStart(2, '0');
        const stormName = `${basinCode} ${cycloneNum}`;

        if (state.cyclone && state.cyclone.track && state.cyclone.track.length > 0) {
            state.cyclone.track.forEach(p => {
                if (p[2] > peakWind) peakWind = p[2];
                const p_val = p[10] !== undefined ? p[10] : windToPressure(p[2], p[5] || 300, currentBasin, getPressureAt(p[0], p[1], state.pressureSystems));
                if (p_val < minPressure) minPressure = p_val;
            });
        }

        const currentYear = new Date().getFullYear();
        const startDate = new Date(Date.UTC(currentYear, state.currentMonth - 1, 1));
        const totalHours = state.cyclone.age || 0;
        const endDate = new Date(startDate.getTime() + totalHours * 3600 * 1000);

        const fmtDate = (date) => `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
        const dateRangeStr = `${fmtDate(startDate)} ~ ${fmtDate(endDate)}`;

        html2canvas(captureElement, {
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#111827',
            logging: false
        }).then(canvas => {
            const ctx = canvas.getContext('2d');

            const panelX = 20, panelY = 20, panelWidth = 340, panelHeight = 110, radius = 12;

            ctx.save();
            ctx.fillStyle = 'rgba(17, 24, 39, 0.85)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 1;

            ctx.beginPath();
            ctx.roundRect(panelX, panelY, panelWidth, panelHeight, radius);
            ctx.fill();
            ctx.stroke();

            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';

            ctx.font = 'bold 24px "JetBrains Mono", monospace';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(stormName, panelX + 20, panelY + 20);

            const nameWidth = ctx.measureText(stormName).width;
            ctx.font = '16px "JetBrains Mono", monospace';
            ctx.fillStyle = '#9ca3af';
            ctx.fillText(dateRangeStr, panelX + 20 + nameWidth + 15, panelY + 26);

            ctx.beginPath();
            ctx.moveTo(panelX + 20, panelY + 55);
            ctx.lineTo(panelX + panelWidth - 20, panelY + 55);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.stroke();

            ctx.font = 'bold 20px "JetBrains Mono", monospace';
            ctx.fillStyle = '#facc15';
            ctx.fillText("MAX", panelX + 20, panelY + 70);

            const labelWidth = ctx.measureText("MAX ").width;
            ctx.fillStyle = '#ffffff';
            const windText = `${Math.round(peakWind)} KT`;
            ctx.fillText(windText, panelX + 20 + labelWidth, panelY + 70);

            const windTotalWidth = labelWidth + ctx.measureText(windText).width;
            const gap = 20;

            ctx.fillStyle = '#22d3ee';
            const pressureX = panelX + 20 + windTotalWidth + gap;
            ctx.fillText("MIN", pressureX, panelY + 70);

            const pLabelWidth = ctx.measureText("MIN ").width;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(`${Math.round(minPressure)} hPa`, pressureX + pLabelWidth, panelY + 70);
            ctx.restore();

            const disclaimerText = "GENERATED BY TCS-SIM | NOT REAL EVENT";
            ctx.font = '12px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.fillText(disclaimerText, panelX + 300, panelY + 125);

            const link = document.createElement('a');
            link.href = canvas.toDataURL('image/png');
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }).catch(err => {
            console.error('Snapshot failed:', err);
        });
    }

    function downloadHistoryTrack() {
        if (state.selectedHistoryTrackData) {
            const blob = new Blob([state.selectedHistoryTrackData], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const fileNameMatch = state.selectedHistoryTrackData.split('\n')[0].match(/^(\S+), (\S+)/);
            const fileName = fileNameMatch ? `${fileNameMatch[1]}${fileNameMatch[2]}.txt` : 'history_track.txt';
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            alert("No historical track data available for download.");
        }
    }

    // helpers
    function updateToggleButtonVisual(button, isActive) {
        if (isActive) {
            button.classList.remove('bg-slate-900', 'text-slate-300', 'border-slate-600', 'hover:text-cyan-400');
            button.classList.add('bg-slate-700', 'text-cyan-400', 'border-cyan-500', 'shadow-md', 'shadow-cyan-900/20');
        } else {
            button.classList.add('bg-slate-900', 'text-slate-300', 'border-slate-600', 'hover:text-cyan-400');
            button.classList.remove('bg-slate-700', 'text-cyan-400', 'border-cyan-500', 'shadow-md', 'shadow-cyan-900/20');
        }
    }

    function changeSimulationSpeed(newInterval) {
        state.simulationSpeed = newInterval;

        const speedMap = { 50: 'MAX (3x)', 100: 'FAST (2x)', 200: 'NORMAL (1x)' };
        const speedText = speedMap[newInterval] || `${newInterval}ms`;

        if (state.simulationInterval && !state.isPaused && state.cyclone.status === 'active') {
            clearInterval(state.simulationInterval);
            state.simulationInterval = setInterval(updateSimulation, state.simulationSpeed);
            document.getElementById('status').textContent = `SPEED CHANGED: ${speedText}`;
            setTimeout(() => {
                if(state.simulationInterval) document.getElementById('status').textContent = "Simulation in Progress...";
            }, 1000);
        }
    }

    function getAtcfTypeCode(windKts, isExtratropical, isSubtropical) {
        if (isSubtropical) {
            if (windKts < 34) return 'SD';
            return 'SS';
        }
        if (isExtratropical) return 'EX';
        if (windKts >= 130) return 'ST';
        if (windKts >= 64) return 'TY';
        if (windKts >= 34) return 'TS';
        if (windKts >= 24) return 'TD';
        if (windKts > 0) return 'DB';
        return 'LO';
    }

    // format decimal degrees with hemisphere letter (e.g. 13.79N, 137.82E)
    function formatDegreeWithHemisphere(value, isLat) {
        let val = value;
        if (!isLat) {
            if (val > 180) val = val - 360;
        }
        const hemi = val >= 0 ? (isLat ? 'N' : 'E') : (isLat ? 'S' : 'W');
        const absVal = Math.abs(val);
        return `${absVal.toFixed(2)}${hemi}`;
    }

    function formatBestTrack(track, cycloneInfo, simulationCount, stepHours = 3) {
            const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
            const basin = (basinMap[cycloneInfo.basin] || 'WP').padEnd(2, ' ');
            const cycloneNum = String(simulationCount).padStart(3, ' ');
            const startDateMs = new Date(Date.UTC(cycloneInfo.year, cycloneInfo.month - 1, 1)).getTime();

            let output = "";
            const stepMs = stepHours * 3600000;

            for (let i = 0; i < track.length; i++) {
                const point = track[i];
                const currentDate = new Date(startDateMs + (i * stepMs));

                const yyyy = currentDate.getUTCFullYear();
                const mm = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
                const dd = String(currentDate.getUTCDate()).padStart(2, '0');
                const hh = String(currentDate.getUTCHours()).padStart(2, '0');

                const lat = formatDegreeWithHemisphere(point[1], true).padStart(6, ' ');
                const lon = formatDegreeWithHemisphere(point[0], false).padStart(7, ' ');

                const vmax = Math.round(point[2]);
                const mslp = point[10] !== undefined && point[10] !== null
                    ? point[10]
                    : Math.round(windToPressure(vmax, point[5] || 300, cycloneInfo.basin, getPressureAt(point[0], point[1], state.pressureSystems)));

                const type = getAtcfTypeCode(vmax, point[4], point[6]);

                output += `${basin}, ${cycloneNum},  ${yyyy}${mm}${dd}${hh},  00,  BEST,    0, ${lat}, ${lon}, ${String(vmax).padStart(4, ' ')}, ${String(mslp).padStart(5, ' ')},  ${type}\n`;
            }

            return output.trim();
    }

    function drawRadarScope() {
        if ((!state.radarMode && !state.dopplerMode) || !state.siteLon || !state.siteLat) {
            if (radarCanvas) radarCanvas.classList.add('hidden');
            if (radarOverlayCanvas) radarOverlayCanvas.classList.add('hidden');
            return;
        }
        if (!radarRenderer || !dopplerRenderer) return;

        const { width, height } = mapContainer.node().getBoundingClientRect();
        if (radarOverlayCanvas.width !== width || radarOverlayCanvas.height !== height) {
            radarOverlayCanvas.width = width;
            radarOverlayCanvas.height = height;
        }

        const centerProj = mapProjection([state.siteLon, state.siteLat]);
        if (!centerProj) return;
        const [cx, cy] = centerProj;

        const refPoint = mapProjection([state.siteLon + (460 / 111), state.siteLat]);
        const radiusPx = Math.abs(refPoint[0] - cx);

        // WebGL renderer positioning
        const mode = state.dopplerMode ? 'doppler' : 'radar';
        const age = state.cyclone ? state.cyclone.age : 0;

        // only proceed if tracking or map state changed
        const isDirty = lastRadarState.age !== age ||
                        lastRadarState.siteLon !== state.siteLon ||
                        lastRadarState.siteLat !== state.siteLat ||
                        lastRadarState.cx !== cx ||
                        lastRadarState.cy !== cy ||
                        lastRadarState.radiusPx !== radiusPx ||
                        lastRadarState.mode !== mode;

        if (!isDirty) return;

        lastRadarState.age = age;
        lastRadarState.siteLon = state.siteLon;
        lastRadarState.siteLat = state.siteLat;
        lastRadarState.cx = cx;
        lastRadarState.cy = cy;
        lastRadarState.radiusPx = radiusPx;
        lastRadarState.mode = mode;

        radarCanvas.classList.remove('hidden');
        radarOverlayCanvas.classList.remove('hidden');

        // render scale properties only on dimensional changes
        const size = radiusPx * 2;
        if (parseFloat(radarCanvas.style.width) !== size) {
            radarCanvas.style.width = `${size}px`;
            radarCanvas.style.height = `${size}px`;
            radarCanvas.style.left = `${cx - radiusPx}px`;
            radarCanvas.style.top = `${cy - radiusPx}px`;
        }

        if (state.dopplerMode) {
            dopplerRenderer.render(state, 256, 256);
            radarCanvas.style.opacity = "0.75";
        } else if (state.radarMode) {
            // render using the cached background humidity computed in updateStateSiteData
            radarRenderer.render(state, 256, 256, state.cachedHumidity !== undefined ? state.cachedHumidity : 0.7);
            radarCanvas.style.opacity = "0.65";
        }

        // draw scanning UI lines
        const ctx = radarOverlayCtx;
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1.5;

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
        ctx.clip();

        ctx.beginPath();
        ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // UI updates
    function triggerNewsBanner(headlineHTML, subText, currentAge, currentMonth, type = 'ORANGE') {
        const container = document.getElementById('news-feed-container');
        if (!container) return;

        if (type === 'ORANGE') playUpgradeSound();
        else if (type === 'RED') playAlert();
        else if (type === 'PURPLE') playCat5Sound();
        else playClick();

        const startDate = new Date(Date.UTC(new Date().getFullYear(), currentMonth - 1, 1));
        const currentDate = new Date(startDate.getTime() + currentAge * 3600 * 1000);

        const m = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(currentDate.getUTCDate()).padStart(2, '0');
        const h = String(currentDate.getUTCHours()).padStart(2, '0');
        const dateStr = `${m}/${d} ${h}Z`;

        const themeColor = type === 'RED' ? '#dc2626' : type === 'PURPLE' ? '#a855f7' : '#ea580c';
        const borderColor = type === 'RED' ? 'border-[#dc2626]' : type === 'PURPLE' ? 'border-[#a855f7]' : 'border-[#ea580c]';

        const newsItem = document.createElement('div');
        newsItem.className = `transform translate-x-full transition-transform duration-500 ease-out flex flex-col items-end font-mono shadow-2xl pointer-events-auto`;

        newsItem.innerHTML = `
            <div class="text-white px-6 py-2 flex items-center gap-3 shadow-lg" style="background-color: ${themeColor}">
                <h2 class="text-xl md:text-2xl font-black uppercase tracking-tighter italic leading-none drop-shadow-md text-right">
                    ${headlineHTML}
                </h2>
                <div class="w-2 h-6 bg-white animate-pulse"></div>
            </div>
            <div class="bg-black/90 text-slate-300 px-6 py-1.5 border-r-4 ${borderColor} flex justify-between items-center gap-4 min-w-[300px] shadow-lg w-full">
                <span class="text-[10px] md:text-xs font-mono text-orange-400">${dateStr}</span>
                <span class="text-[10px] md:text-xs font-bold tracking-widest uppercase text-slate-400 text-right">${subText}</span>
            </div>
        `;

        container.appendChild(newsItem);

        requestAnimationFrame(() => newsItem.classList.remove('translate-x-full'));

        setTimeout(() => {
            newsItem.classList.add('translate-x-full');
            setTimeout(() => { if (newsItem.parentNode) newsItem.parentNode.removeChild(newsItem); }, 500);
        }, 6000);
    }

    function updateInfoPanel() {
            if (!updateInfoPanel.ui) {
                updateInfoPanel.ui = {
                    simTime: document.getElementById('simulationTime'),
                    lat: document.getElementById('latitude'),
                    lon: document.getElementById('longitude'),
                    intensity: document.getElementById('intensity'),
                    pressure: document.getElementById('pressure'),
                    category: document.getElementById('category'),
                    ace: document.getElementById('ace'),
                    direction: document.getElementById('direction'),
                    speed: document.getElementById('speed'),
                    status: document.getElementById('status')
                };
                updateInfoPanel.cache = {}; // Cache to prevent DOM layout thrashing
            }

            const updateDOM = (key, value) => {
                if (updateInfoPanel.cache[key] !== value) {
                    updateInfoPanel.ui[key].textContent = value;
                    updateInfoPanel.cache[key] = value;
                }
            };

            const cat = getCategory(state.cyclone.intensity, state.cyclone.isTransitioning, state.cyclone.isExtratropical, state.cyclone.isSubtropical);

            updateDOM('simTime', `SIM T+${state.cyclone.age} HRS`);
            updateDOM('lat', `${state.cyclone.lat.toFixed(1)}°N`);
            updateDOM('lon', `${state.cyclone.lon.toFixed(1)}°E`);
            updateDOM('intensity', `${knotsToKph(state.cyclone.intensity)} kph (${knotsToMph(state.cyclone.intensity)} mph)`);

            const centerEnvP = getPressureAt(state.cyclone.lon, state.cyclone.lat, state.pressureSystems);
            const centralPressure = windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, state.cyclone.basin, centerEnvP);

            updateDOM('pressure', `${centralPressure.toFixed(0)} hPa`);
            updateDOM('category', cat.name);
            updateDOM('ace', state.cyclone.ace.toFixed(2));
            updateDOM('direction', `${directionToCompass(state.cyclone.direction)}`);
            updateDOM('speed', `${state.cyclone.speed.toFixed(0)} kts`);

            const isLand = state.cyclone.isLand || false;
            const currentSST = getSST(state.cyclone.lat, state.cyclone.lon, state.currentMonth, state.GlobalTemp);
            const cycloneNum = String(state.simulationCount).padStart(2, '0');

            let peakWindSoFar = 0;
            if (state.cyclone.track) {
                for (let i = 0; i < state.cyclone.track.length; i++) {
                    if (state.cyclone.track[i][2] > peakWindSoFar) peakWindSoFar = state.cyclone.track[i][2];
                }
            }

            const stormName = state.cyclone.name ? state.cyclone.name.toUpperCase() : "UNKNOWN";
            let statusText = "";

            if (peakWindSoFar >= 34 || state.cyclone.named) {
                if (state.cyclone.intensity >= 34) {
                    statusText = state.cyclone.isExtratropical ? `EX-${stormName}` : stormName;
                } else {
                    statusText = state.cyclone.isExtratropical ? `EX-${stormName}`
                               : state.cyclone.isSubtropical ? `SD ${stormName}` : `TD ${stormName}`;
                }
            } else {
                statusText = state.cyclone.isExtratropical ? `EX ${cycloneNum}`
                           : state.cyclone.isSubtropical ? `SD ${cycloneNum}` : `TD ${cycloneNum}`;
            }

            updateDOM('status', statusText);

            let effectiveHumidity = 75;
            if (state.cyclone && state.pressureSystems) {
                const samplingRadiusDeg = state.cyclone.circulationSize * 0.005;
                const cosLat = 1.0 / Math.max(0.1, Math.cos(state.cyclone.lat * DEG_TO_RAD));
                let envHumiditySum = 0;
                let minEnvHumidity = 60;
                const samplePoints = 8;

                for (let i = 0; i < samplePoints; i++) {
                    const angleRad = (i / samplePoints) * 2 * Math.PI;
                    const sampleLon = state.cyclone.lon + samplingRadiusDeg * Math.cos(angleRad) * cosLat;
                    const sampleLat = state.cyclone.lat + samplingRadiusDeg * Math.sin(angleRad);

                    const val = calculateBackgroundHumidity(sampleLon, sampleLat, state.pressureSystems, state.currentMonth, state.cyclone, state.GlobalTemp);
                    envHumiditySum += val;
                    if (val < minEnvHumidity) minEnvHumidity = val;
                }
                effectiveHumidity = (minEnvHumidity * 0.4) + ((envHumiditySum / samplePoints) * 0.6);
            }

            updateSatelliteView(
                state.cyclone.intensity, state.cyclone.age, state.cyclone.lat,
                state.cyclone.isExtratropical, state.cyclone.isSubtropical, isLand, currentSST, effectiveHumidity
            );

            if (state.cyclone.age % 6 === 0) {
                const snapshotData = getSatelliteSnapshot();
                if (snapshotData) {
                    if (!state.cyclone.satelliteCache) state.cyclone.satelliteCache = [];
                    const cacheIndex = (state.cyclone.age / 6) % 48;
                    state.cyclone.satelliteCache[cacheIndex] = { age: state.cyclone.age, img: snapshotData, timestamp: Date.now() };
                }
            }
        }

        function updateMapInfoBox() {
            if (!updateMapInfoBox.ui) {
                updateMapInfoBox.ui = {
                    time: document.getElementById('map-info-time'),
                    intensity: document.getElementById('map-info-intensity'),
                    movement: document.getElementById('map-info-movement')
                };
                updateMapInfoBox.cache = {};
            }

            const updateDOM = (key, text) => {
                if (updateMapInfoBox.cache[key] !== text) {
                    updateMapInfoBox.ui[key].textContent = text;
                    updateMapInfoBox.cache[key] = text;
                }
            };

            const cat = getCategory(state.cyclone.intensity, state.cyclone.isTransitioning, state.cyclone.isExtratropical, state.cyclone.isSubtropical);
            updateDOM('time', `T+${state.cyclone.age}h`);
            updateDOM('intensity', `${cat.shortName} - ${state.cyclone.intensity.toFixed(0)}KT`);

            const centerEnvP = getPressureAt(state.cyclone.lon, state.cyclone.lat, state.pressureSystems);
            const pVal = windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, state.cyclone.basin, centerEnvP);
            updateDOM('movement', `${pVal.toFixed(0)}hPa ${directionToCompass(state.cyclone.direction)} ${state.cyclone.speed.toFixed(0)}KT`);
        }

        function updateStateSiteData() {
                if (state.siteLon != null && state.siteLat != null) {
                    let vec = getWindVectorAt(state.siteLon, state.siteLat, state.currentMonth, state.cyclone, state.pressureSystems);

                    if (state.world) {
                        if (state.siteLon !== state.cachedSiteLon || state.siteLat !== state.cachedSiteLat) {
                            state.cachedSiteLon = state.siteLon;
                            state.cachedSiteLat = state.siteLat;
                            state.cachedSiteFriction = 1.0;

                            const landStatus = getLandStatus(state.siteLon, state.siteLat, 0.1);
                            if (landStatus.isLand) {
                                state.cachedSiteFriction = 0.78;
                            } else if (landStatus.isNearLand) {
                                state.cachedSiteFriction = 0.89;
                            }
                        }

                        vec.magnitude *= state.cachedSiteFriction;
                        vec.u *= state.cachedSiteFriction;
                        vec.v *= state.cachedSiteFriction;
                    }

                    const speedKt = Math.round(vec.magnitude + Math.random());
                    const flowAngleMath = Math.atan2(-vec.v, vec.u) * RAD_TO_DEG;
                    let windDir = (flowAngleMath + 250) % 360;
                    if (windDir < 0) windDir += 360;
                    const dirText = directionToCompass(windDir);

                    state.cachedHumidity = calculateBackgroundHumidity(
                        state.siteLon, state.siteLat, state.pressureSystems,
                        state.currentMonth, state.cyclone && state.cyclone.status === 'active' ? state.cyclone : null,
                        state.GlobalTemp
                    ) / 100.0;

                    const dbz = calculateRadarDbz(state.siteLon, state.siteLat, state);
                    let weatherIcon = '<i class="fa-solid fa-sun text-yellow-500"></i>';
                    if (dbz >= 50) weatherIcon = '<i class="fa-solid fa-cloud-bolt text-yellow-500"></i>';
                    else if (dbz >= 35) weatherIcon = '<i class="fa-solid fa-cloud-showers-heavy text-blue-500"></i>';
                    else if (dbz >= 15) weatherIcon = '<i class="fa-solid fa-cloud-rain text-blue-400"></i>';
                    else if (dbz >= 5) weatherIcon = '<i class="fa-solid fa-cloud text-slate-400"></i>';

                    const label = `${weatherIcon} <span style="margin-left:2px;">${dirText}</span> / ${speedKt}KT`;
                    let localPressure = 1010;

                    const currentSimHour = (state.cyclone && state.cyclone.age) ? state.cyclone.age : 0;
                    const localHour = (currentSimHour + state.siteLon / 15) % 24;

                    if (state.siteLat !== lastSiteLatForTide) {
                        lastSiteLatForTide = state.siteLat;
                        cachedLatFactor = Math.max(0, Math.cos(state.siteLat * DEG_TO_RAD));
                    }
                    const tideAmplitude = 1.6 * cachedLatFactor;
                    const diurnalBias = tideAmplitude * Math.cos(((localHour - 10) / 12) * 2 * Math.PI);
                    const microNoise = (Math.random() - 0.5) * 0.2;
                    const Pn = getPressureAt(state.siteLon, state.siteLat, state.pressureSystems);

                    if (state.cyclone && state.cyclone.status === 'active') {
                        const distKm = calculateDistance(state.cyclone.lat, state.cyclone.lon, state.siteLat, state.siteLon);
                        const Rm = 10 + state.cyclone.circulationSize * 0.25;
                        const Pc = windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, basinSelector.value, getPressureAt(state.cyclone.lon, state.cyclone.lat, state.pressureSystems));
                        localPressure = Pc + (Pn - Pc) * Math.exp(-Rm / Math.max(1, distKm)) + diurnalBias + microNoise;
                    } else {
                        localPressure = Pn + diurnalBias + microNoise;
                    }

                    if (!state.currentSiteData) {
                        state.currentSiteData = {};
                    }

                    state.currentSiteData.u = vec.u;
                    state.currentSiteData.v = vec.v;
                    state.currentSiteData.magnitude = vec.magnitude;
                    state.currentSiteData.displaySpeed = speedKt;
                    state.currentSiteData.label = label;
                    state.currentSiteData.dbz = dbz;
                    state.currentSiteData.pressure = localPressure;
                    state.currentSiteData.isSelected = state.isSiteSelected;

                } else {
                    state.currentSiteData = null;
                }
        }

    // core simulation loop
    function updateSimulation() {
            if (state.cyclone.status !== 'active') {
                clearInterval(state.simulationInterval);
                state.simulationInterval = null;
                state.isPaused = false;

                const basinId = basinSelector.value || 'WPAC';
                const cycloneInfo = { basin: basinId, month: state.currentMonth, year: new Date().getFullYear() };
                const bestTrackText = formatBestTrack(state.cyclone.track, cycloneInfo, state.simulationCount);

                const basinCode = bestTrackText.split('\n')[0].split(',')[0].trim();
                const cycloneNumStr = String(state.simulationCount).padStart(2, '0');

                let peakWind = 0, minPressure = 9999;
                state.cyclone.track.forEach(point => {
                    if (point[2] > peakWind) peakWind = point[2];
                    const pressure = point[10] !== undefined && point[10] !== null ? point[10] : Math.round(windToPressure(point[2], point[5] || 300, basinId));
                    if (pressure < minPressure) minPressure = pressure;
                });

                const stormName = state.cyclone.name ? state.cyclone.name.toUpperCase() : "UNKNOWN";
                let statusText = "";

                if (peakWind >= 34 || state.cyclone.named) {
                    statusText = state.cyclone.intensity >= 34
                        ? (state.cyclone.isExtratropical ? `EX-${stormName}` : stormName)
                        : (state.cyclone.isExtratropical ? `EX-${stormName}` : state.cyclone.isSubtropical ? `SD ${stormName}` : `TD ${stormName}`);
                } else {
                    statusText = state.cyclone.isExtratropical ? `EX ${cycloneNumStr}` : state.cyclone.isSubtropical ? `SD ${cycloneNumStr}` : `TD ${cycloneNumStr}`;
                }

                document.getElementById('status').textContent = statusText;
                document.getElementById('map-info-box').classList.add('hidden');

                pauseButton.disabled = true;
                pauseButton.innerHTML = '<i class="fa-solid fa-pause text-xs"></i>';
                monthSelector.disabled = false;
                basinSelector.disabled = false;
                globalTempSlider.disabled = false;
                globalShearSlider.disabled = false;
                siteNameInput.disabled = false;
                customLonInput.disabled = false;
                customLatInput.disabled = false;
                siteLonInput.disabled = false;
                siteLatInput.disabled = false;

                const finalStats = { number: `${basinCode} ${cycloneNumStr}`, peakWind: Math.round(peakWind), minPressure: Math.round(minPressure), ace: state.cyclone.ace.toFixed(2) };
                state.lastFinalStats = finalStats;

                drawFinalPath(mapSvg, mapProjection, state.world, state.cyclone, tooltip, state.siteName, state.siteLon, state.siteLat, state.showPathPoints, finalStats, basinId, state.pressureSystems, state.showWindField);
                requestRedraw();

                if (state.showIntensityChart) forecastContainer.classList.remove('hidden');
                setTimeout(() => drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip), 0);

                bestTrackData.value = bestTrackText;
                bestTrackContainer.classList.remove('hidden');
                copyTrackButton.textContent = "Copy Data";

                try {
                    const historyName = `${statusText} (${basinCode} ${cycloneNumStr}) - T+${state.cyclone.age}h, Peak ${Math.round(peakWind)}kt`;

                    const cycloneDataDeep = structuredClone ? structuredClone(state.cyclone) : JSON.parse(JSON.stringify(state.cyclone));

                    state.history.push({
                        name: historyName,
                        cycloneData: cycloneDataDeep,
                        atcfData: bestTrackText,
                        pressureHistory: state.pressureHistory.map(h => ({
                            age: h.age, month: h.month,
                            lower: h.lower.map(l => ({...l})),
                            upper: h.upper.map(u => ({...u}))
                        })),
                        siteHistory: state.siteHistory.map(s => ({...s}))
                    });
                    state.simulationCount++;
                } catch (e) { console.error("Failed to save history:", e); }
                return;
            }

            const wasNamed = state.cyclone.named;
            state.pressureSystems = updatePressureSystems(state.pressureSystems, state.cyclone.currentMonth, state.GlobalTemp, state.GlobalShear);
            state.frontalZone = updateFrontalZone(state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
            state.cyclone = updateCycloneState(state.cyclone, state.pressureSystems, state.frontalZone, state.world, state.currentMonth, state.GlobalTemp, state.GlobalShear, state.nextNameIndex);
            state.cyclone.currentMonth = state.currentMonth;

            if (state.cyclone.status === 'active') {
                state.pressureHistory.push({
                    age: state.cyclone.age,
                    month: state.cyclone.currentMonth,
                    lower: state.pressureSystems.lower ? state.pressureSystems.lower.map(s => ({ ...s })) : [],
                    upper: state.pressureSystems.upper ? state.pressureSystems.upper.map(s => ({ ...s })) : []
                });
            }

            if (!wasNamed && state.cyclone.named) state.nextNameIndex++;

            if (!state.hasTriggeredCat1News && state.cyclone.intensity >= 64 && !state.cyclone.isExtratropical) {
                state.hasTriggeredCat1News = true;
                const displayName = state.cyclone.name ? state.cyclone.name.toUpperCase() : `SYSTEM ${String(state.simulationCount).padStart(2, '0')}`;
                const stormTerm = basinSelector.value === 'WPAC' ? "TYPHOON" : ['NIO', 'SIO', 'SHEM'].includes(basinSelector.value) ? "CAT-1 CYCLONE" : "HURRICANE";
                triggerNewsBanner(`${displayName} <span class="text-black/50 text-base align-middle not-italic ml-2 font-bold">HAS BECOME A ${stormTerm}</span>`, "BREAKING NEWSLETTER", state.cyclone.age, state.currentMonth, 'ORANGE');
            }

            if (!state.hasTriggeredCat5News && state.cyclone.intensity >= 137 && !state.cyclone.isExtratropical) {
                state.hasTriggeredCat5News = true;
                const displayName = state.cyclone.name ? state.cyclone.name.toUpperCase() : `SYSTEM ${String(state.simulationCount).padStart(2, '0')}`;
                const statusTerm = basinSelector.value === 'WPAC' ? "CAT-5 SUPER TYPHOON" : "CATEGORY 5 HURRICANE";
                triggerNewsBanner(`${displayName} <span class="text-black/60 text-base align-middle not-italic ml-2 font-black">ACHIEVED ${statusTerm} STATUS</span>`, "EXTREME INTENSITY ALERT", state.cyclone.age, state.currentMonth, 'PURPLE');
            }

            if (state.siteLon != null && state.siteLat != null) {
                const dist = calculateDistance(state.cyclone.lat, state.cyclone.lon, state.siteLat, state.siteLon);
                if (dist <= 400 && state.cyclone.intensity >= 34) {
                    if (!state.hasAlerted) {
                        playAlert();
                        state.hasAlerted = true;
                        const displayName = state.cyclone.name ? state.cyclone.name.toUpperCase() : `SYSTEM ${String(state.simulationCount).padStart(2, '0')}`;
                        triggerNewsBanner(`ALERT: <span class="text-white text-base align-middle not-italic ml-2 font-bold">${displayName} ENTERED 400KM WARNING RANGE</span>`, `THREAT TO ${state.siteName ? state.siteName.toUpperCase() : "OBSERVATION POST"}`, state.cyclone.age, state.currentMonth, 'RED');
                    }
                } else {
                    state.hasAlerted = false;
                }
            }

            updateInfoPanel();
            updateMapInfoBox();
            updateStateSiteData();

            if (state.currentSiteData) {
                const currentHour = state.cyclone.age;
                const lastEntry = state.siteHistory[state.siteHistory.length - 1];
                if (!lastEntry || lastEntry.hour !== currentHour) {
                     state.siteHistory.push({
                        hour: currentHour,
                        wind: state.currentSiteData.displaySpeed,
                        pressure: state.currentSiteData.pressure,
                        u: state.currentSiteData.u,
                        v: state.currentSiteData.v,
                        dbz: state.currentSiteData.dbz,
                        lat: state.siteLat,
                        lon: state.siteLon
                    });
                }
            }

            drawMap(mapSvg, mapProjection, state.world, state.cyclone, {
                pathForecasts: state.pathForecasts,
                pressureSystems: state.pressureSystems,
                showPressureField: state.showPressureField,
                showHumidityField: state.showHumidityField,
                showPathForecast: state.showPathForecast,
                showWindRadii: state.showWindRadii,
                siteName: state.siteName,
                siteLon: state.siteLon,
                siteLat: state.siteLat,
                showPathPoints: state.showPathPoints,
                showWindField: state.showWindField,
                month: state.currentMonth,
                siteHistory: state.siteHistory,
                siteData: state.currentSiteData,
                onSiteClick: () => {
                    state.isSiteSelected = !state.isSiteSelected;
                    requestRedraw();
                }
            });

            if (state.cyclone.age % 3 === 0 && state.cyclone.age > 0) {
                 const forecasts = generatePathForecasts(state.cyclone, state.pressureSystems, checkLandWrapper, state.GlobalTemp, state.GlobalShear);
                 state.pathForecasts = forecasts;

                 if (state.cyclone.age % 6 === 0) {
                     if (!state.cyclone.forecastLogs) state.cyclone.forecastLogs = {};

                     state.cyclone.forecastLogs[state.cyclone.age] = forecasts.map(m => ({
                         ...m,
                         track: m.track.map(p => p.slice())
                     }));
                 }
            }
            if (state.cyclone.track.length > 3) {
                generateJTWCButton.classList.remove('hidden');
            }
    }

    function startSimulation() {
        playStart();
        selectedHistoryPointIndex = -1;
        if (state.simulationInterval) clearInterval(state.simulationInterval);
        state.isPaused = false;
        state.hasAlerted = false;
        state.hasTriggeredCat1News = false;
        state.hasTriggeredCat5News = false;
        state.siteHistory = [];
        state.pressureHistory = [];
        state.isSiteSelected = false;
        state.selectedHistoryCyclone = null;
        if (!state.world) return;

        resetSatelliteParams();
        setupCanvases();
        document.getElementById('initial-message').classList.add('hidden');
        document.getElementById('simulation-output').classList.remove('hidden');
        document.getElementById('satellite-window').classList.remove('hidden');
        document.getElementById('info-panel').classList.remove('hidden');
        if (document.getElementById('restore-sat-btn')) document.getElementById('restore-sat-btn').classList.add('hidden');

        const newsContainer = document.getElementById('news-feed-container');
        if (newsContainer) newsContainer.innerHTML = '';

        forecastContainer.classList.add('hidden');
        document.getElementById('map-info-box').classList.remove('hidden');
        bestTrackContainer.classList.add('hidden');

        generateButton.innerHTML = '<span class="relative z-10 flex items-center justify-center gap-2"><i class="fa-solid fa-power-off"></i> RESTART</span>';
        pauseButton.disabled = false;
        pauseButton.innerHTML = '<i class="fa-solid fa-pause text-xs"></i>';

        const selectedBasin = basinSelector.value;
        if (!state.lastBasin || state.lastBasin !== selectedBasin) {
            const list = NAME_LISTS[selectedBasin] || NAME_LISTS['WPAC'];
            state.nextNameIndex = Math.floor(Math.random() * list.length);
        }
        state.lastBasin = selectedBasin;
        state.currentMonth = parseInt(monthSelector.value, 10);
        monthSelector.disabled = true;
        basinSelector.disabled = true;
        globalTempSlider.disabled = true;
        globalShearSlider.disabled = true;
        siteNameInput.disabled = true;
        customLonInput.disabled = true;
        customLatInput.disabled = true;
        siteLonInput.disabled = true;
        siteLatInput.disabled = true;
        settingsMenu.classList.add('hidden');

        state.cyclone = initializeCyclone(state.world, state.currentMonth, selectedBasin, state.GlobalTemp, state.GlobalShear, state.customLon, state.customLat);
        state.cyclone.track.push([state.cyclone.lon, state.cyclone.lat, state.cyclone.intensity, false, false, state.cyclone.circulationSize, state.cyclone.isSubtropical]);
        state.pressureSystems = initializePressureSystems(state.cyclone, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.frontalZone = updateFrontalZone(state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        state.pathForecasts = generatePathForecasts(state.cyclone, state.pressureSystems, checkLandWrapper, state.GlobalTemp, state.GlobalShear);

        updateToggleButtonVisual(togglePressureButton, state.showPressureField);
        updateToggleButtonVisual(toggleWindRadiiButton, state.showWindRadii);
        updateToggleButtonVisual(togglePathButton, state.showPathForecast);
        state.simulationInterval = setInterval(updateSimulation, state.simulationSpeed);
    }

    function togglePause() {
        if (!state.cyclone.status || state.cyclone.status !== 'active') {
            playError();
            return;
        }
        playClick();
        state.isPaused = !state.isPaused;
        if (state.isPaused) {
            clearInterval(state.simulationInterval);
            state.simulationInterval = null;
            pauseButton.innerHTML = '<i class="fa-solid fa-play text-xs"></i>';
            document.getElementById('status').textContent = "Simulation Paused";
            requestRedraw();
        } else {
            state.simulationInterval = setInterval(updateSimulation, state.simulationSpeed);
            pauseButton.innerHTML = '<i class="fa-solid fa-pause text-xs"></i>';
            updateInfoPanel();
        }
    }

    function requestRedraw() {
        updateStateSiteData();
        const isCycloneActive = state.cyclone && state.cyclone.status === 'active';
        const onSiteClickCallback = () => {
            state.isSiteSelected = !state.isSiteSelected;
            requestRedraw();
        };
        if (state.world && mapSvg) {
            if (isCycloneActive || !state.cyclone.track || state.cyclone.track.length < 2) {
                drawMap(mapSvg, mapProjection, state.world, state.cyclone, {
                    pathForecasts: isCycloneActive ? state.pathForecasts : [],
                    pressureSystems: state.pressureSystems,
                    showPressureField: isCycloneActive && state.showPressureField,
                    showHumidityField: isCycloneActive && state.showHumidityField,
                    showPathForecast: isCycloneActive && state.showPathForecast,
                    showWindRadii: isCycloneActive && state.showWindRadii,
                    siteName: state.siteName,
                    siteLon: state.siteLon,
                    siteLat: state.siteLat,
                    showPathPoints: state.showPathPoints,
                    showWindField: isCycloneActive && state.showWindField,
                    month: state.currentMonth,
                    siteHistory: state.siteHistory,
                    siteData: state.currentSiteData,
                    onSiteClick: onSiteClickCallback,
                    isPaused: state.isPaused,
                    onSystemRemove: (systemData) => {
                        if (!systemData.isManual) return;
                        const removeManual = (list) => {
                            const idx = list.findIndex(s => s.isManual);
                            if (idx !== -1) list.splice(idx, 1);
                        };
                        if (state.pressureSystems.lower) removeManual(state.pressureSystems.lower);
                        if (state.pressureSystems.upper) removeManual(state.pressureSystems.upper);
                        playToggleOff();
                        requestRedraw();
                    }
                });
            } else {
                const siteDataToPass = state.currentSiteData ? { ...state.currentSiteData, label: null } : null;
                drawFinalPath(
                    mapSvg, mapProjection, state.world, state.cyclone, tooltip,
                    state.siteName, state.siteLon, state.siteLat,
                    state.showPathPoints, state.lastFinalStats, basinSelector.value,
                    state.pressureSystems, state.showWindField,
                    state.currentMonth, state.siteHistory, siteDataToPass, onSiteClickCallback
                );
            }
        }
    }

    function initMusicPlaylist() {
        if (!musicListContainer) return;
        musicListContainer.innerHTML = '';

        musicTracks.forEach((filename, index) => {
            const displayName = filename.replace(/\.mp4$/i, '').replace(/_/g, ' ');
            const li = document.createElement('li');
            li.className = "flex items-center justify-between px-3 py-2 rounded cursor-pointer transition-all border border-transparent hover:bg-white/5 hover:border-white/10 group";

            li.innerHTML = `
                <div class="flex items-center gap-2 overflow-hidden">
                    <i class="fa-solid fa-play text-[10px] text-slate-600 group-hover:text-cyan-400 transition-colors status-icon"></i>
                    <span class="text-xs font-mono text-slate-400 group-hover:text-white truncate transition-colors">${displayName}</span>
                </div>
                <div class="w-1.5 h-1.5 rounded-full bg-cyan-500 opacity-0 active-indicator shadow-[0_0_5px_cyan]"></div>
            `;

            li.addEventListener('click', () => playSelectedTrack(filename, index));
            musicListContainer.appendChild(li);
        });
    }

    function playSelectedTrack(filename, index) {
        if (currentTrackIndex === index && !bgmAudio.paused) {
            bgmAudio.pause();
            updateMusicUI(index, false);
            return;
        }

        bgmAudio.src = filename;
        bgmAudio.volume = bgmVolumeSlider ? bgmVolumeSlider.value : 0.4;

        bgmAudio.play().then(() => {
            currentTrackIndex = index;
            updateMusicUI(index, true);
        }).catch(err => console.error("Playback failed:", err));
    }

    function updateMusicUI(activeIndex, isPlaying) {
        const items = musicListContainer.querySelectorAll('li');
        items.forEach((item, idx) => {
            const icon = item.querySelector('.status-icon');
            const text = item.querySelector('span');
            const indicator = item.querySelector('.active-indicator');

            if (idx === activeIndex) {
                item.classList.add('bg-white/10', 'border-cyan-500/30');
                text.classList.replace('text-slate-400', 'text-cyan-400');
                indicator.classList.remove('opacity-0');
                if (isPlaying) {
                    icon.className = "fa-solid fa-pause text-[10px] text-cyan-400 status-icon";
                    musicButton.classList.add('text-cyan-400', 'border-cyan-500');
                } else {
                    icon.className = "fa-solid fa-play text-[10px] text-cyan-400 status-icon";
                    musicButton.classList.remove('text-cyan-400', 'border-cyan-500');
                }
            } else {
                item.classList.remove('bg-white/10', 'border-cyan-500/30');
                text.classList.replace('text-cyan-400', 'text-slate-400');
                indicator.classList.add('opacity-0');
                icon.className = "fa-solid fa-play text-[10px] text-slate-600 group-hover:text-cyan-400 transition-colors status-icon";
            }
        });
    }

    initMusicPlaylist();

    // event listeners
    generateButton.addEventListener('click', startSimulation);
    pauseButton.addEventListener('click', togglePause);

    downloadTrackButton.addEventListener('click', () => {
        const text = bestTrackData.value;
        if (!text) { alert("No track data available."); return; }

        const basinMap = { 'WPAC': 'WP', 'EPAC': 'EP', 'NATL': 'AL', 'NIO': 'IO', 'SHEM': 'SH', 'SIO': 'SH', 'SATL': 'SL' };
        const basin = basinMap[basinSelector.value] || 'WP';
        const year = new Date().getFullYear();
        const month = String(state.currentMonth).padStart(2, '0');
        const firstLine = text.split('\n')[0];
        const cycloneNum = firstLine ? firstLine.split(',')[1].trim() : '01';

        downloadMapImage('map-container', `map_${basin}${cycloneNum}_${year}${month}.png`);
    });

    downloadHistoryTrackButton.addEventListener('click', downloadHistoryTrack);

    settingsButton.addEventListener('click', () => {
        playClick();
        settingsMenu.classList.toggle('hidden');
    });

    globalTempSlider.addEventListener('input', (e) => {
        state.GlobalTemp = parseInt(e.target.value, 10);
        globalTempValue.textContent = `${state.GlobalTemp}K`;
    });

    globalShearSlider.addEventListener('input', (e) => {
        state.GlobalShear = parseInt(e.target.value, 10);
        globalShearValue.textContent = `${state.GlobalShear}`;
    });

    historyButton.addEventListener('click', () => {
        playClick();
        historyList.innerHTML = '';
        if (state.history.length === 0) {
            historyList.innerHTML = '<li class="text-gray-400 p-2">No historical simulation records.</li>';
        } else {
            [...state.history].reverse().forEach((item, index) => {
                const li = document.createElement('li');
                li.textContent = item.name;
                li.className = 'text-white font-medium py-2 px-3 rounded-md cursor-pointer hover:bg-gray-700 transition-colors';
                li.dataset.historyIndex = state.history.length - 1 - index;
                historyList.appendChild(li);
            });
        }
        historyModal.classList.remove('hidden');
        historyBestTrackContainer.classList.add('hidden');
        state.selectedHistoryTrackData = '';
    });

    closeHistoryModal.addEventListener('click', () => historyModal.classList.add('hidden'));

    historyList.addEventListener('click', (e) => {
        if (e.target && e.target.tagName === 'LI' && e.target.dataset.historyIndex) {
            const index = parseInt(e.target.dataset.historyIndex, 10);
            const historyItem = state.history[index];
            if (!historyItem) return;

            selectedHistoryPointIndex = -1;
            const selectedCyclone = historyItem.cycloneData;
            selectedCyclone.pressureHistory = historyItem.pressureHistory || [];
            selectedCyclone.siteHistory = historyItem.siteHistory || [];
            state.selectedHistoryCyclone = selectedCyclone;

            if (state.simulationInterval) {
                clearInterval(state.simulationInterval);
                state.simulationInterval = null;
            }
            state.isPaused = false;
            pauseButton.disabled = true;

            document.getElementById('initial-message').classList.add('hidden');
            document.getElementById('simulation-output').classList.remove('hidden');
            bestTrackContainer.classList.add('hidden');

            drawFinalPath(mapSvg, mapProjection, state.world, selectedCyclone, tooltip, null, null, null, state.showPathPoints, null, basinSelector.value);
            if (state.showIntensityChart) forecastContainer.classList.remove('hidden');
            drawHistoricalIntensityChart(chartContainer, selectedCyclone.track, tooltip);

            let peak = { intensity: 0 };
            selectedCyclone.track.forEach(p => {
                if(p[2] > peak.intensity) {
                    peak = { lon: p[0], lat: p[1], intensity: p[2], isT: p[3], isE: p[4], circulationSize: p[5] || 300, isS: p[6], pressure: p[10] };
                }
            });
            const peakCat = getCategory(peak.intensity, peak.isT, peak.isE, peak.isS);

            document.getElementById('status').textContent = `Reviewing: ${historyItem.name}`;
            document.getElementById('simulationTime').textContent = `Total Duration: ${selectedCyclone.age} HRS`;
            document.getElementById('latitude').textContent = `${peak.lat.toFixed(1)}°N`;
            document.getElementById('longitude').textContent = `${peak.lon.toFixed(1)}°E`;
            document.getElementById('intensity').textContent = `${knotsToKph(peak.intensity)} kph (${knotsToMph(peak.intensity)} mph)`;

            const displayP = peak.pressure !== undefined && peak.pressure !== null ? peak.pressure : Math.round(windToPressure(peak.intensity, peak.circulationSize, selectedCyclone.basin || state.cyclone.basin || 'WPAC'));
            document.getElementById('pressure').textContent = `${displayP} hPa`;
            document.getElementById('category').textContent = peakCat.name;
            document.getElementById('ace').textContent = selectedCyclone.ace.toFixed(2);
            document.getElementById('direction').textContent = "N/A";
            document.getElementById('speed').textContent = "N/A";

            historyBestTrackData.value = historyItem.atcfData;
            historyBestTrackContainer.classList.remove('hidden');
            state.selectedHistoryTrackData = historyItem.atcfData;
        }
    });

    siteNameInput.addEventListener('input', (e) => {
        state.siteName = e.target.value;
        localStorage.setItem('tcs_site_name', state.siteName);
        requestRedraw();
    });
    siteLonInput.addEventListener('input', (e) => {
        const lon = parseFloat(e.target.value);
        state.siteLon = isNaN(lon) ? null : lon;
        localStorage.setItem('tcs_site_lon', e.target.value);
        requestRedraw();
    });
    siteLatInput.addEventListener('input', (e) => {
        const lat = parseFloat(e.target.value);
        state.siteLat = isNaN(lat) ? null : lat;
        localStorage.setItem('tcs_site_lat', e.target.value);
        requestRedraw();
    });

    const savedShowPoints = localStorage.getItem('tcs_show_points');

    if (showPathPointsCheckbox) {
        if (savedShowPoints !== null) {
            const isChecked = savedShowPoints === 'true';
            showPathPointsCheckbox.checked = isChecked;
            state.showPathPoints = isChecked;
        } else {
            state.showPathPoints = showPathPointsCheckbox.checked;
        }

        showPathPointsCheckbox.addEventListener('change', (e) => {
            const isChecked = e.target.checked;
            state.showPathPoints = isChecked;
            localStorage.setItem('tcs_show_points', isChecked);

            if (typeof playClick === 'function') playClick();

            if (state.cyclone.status === 'active') {
                 requestRedraw();
            } else {
                 drawFinalPath(mapSvg, mapProjection, state.world, state.cyclone, tooltip, state.siteName, state.siteLon, state.siteLat, state.showPathPoints, state.lastFinalStats, basinSelector.value, state.pressureSystems, state.showWindField);
            }
        });
    }

    customLonInput.addEventListener('input', (e) => {
        const lon = parseFloat(e.target.value);
        state.customLon = !isNaN(lon) ? lon : null;
    });
    customLatInput.addEventListener('input', (e) => {
        const lat = parseFloat(e.target.value);
        state.customLat = !isNaN(lat) ? lat : null;
    });

    copyTrackButton.addEventListener('click', () => {
        bestTrackData.select();
        document.execCommand('copy');
        copyTrackButton.textContent = "COPIED!";
    });

    const toggleState = (key, btnId, callback) => {
        state[key] = !state[key];
        const btn = document.getElementById(btnId);
        updateToggleButtonVisual(btn, state[key]);
        if (state[key]) playToggleOn();
        else playToggleOff();

        if (callback) callback(state[key]);
        requestRedraw();
    };

    document.getElementById('togglePressureButton').onclick = () => toggleState('showPressureField', 'togglePressureButton');
    document.getElementById('toggleHumidityButton').onclick = () => toggleState('showHumidityField', 'toggleHumidityButton');
    document.getElementById('toggleWindFieldButton').onclick = () => toggleState('showWindField', 'toggleWindFieldButton');
    document.getElementById('togglePathButton').onclick = () => toggleState('showPathForecast', 'togglePathButton');

    document.getElementById('toggleWindRadiiButton').onclick = () => toggleState('showWindRadii', 'toggleWindRadiiButton', (isShow) => {
        const legend = document.getElementById('wind-radii-legend');
        if (isShow) {
            legend.classList.remove('hidden');
            setTimeout(() => legend.setAttribute('data-show', 'true'), 10);
        } else {
            legend.setAttribute('data-show', 'false');
            setTimeout(() => legend.classList.add('hidden'), 300);
        }
    });

    musicButton.onclick = (e) => {
        e.stopPropagation();
        playClick();
        const isHidden = musicMenu.classList.contains('hidden');
        if (settingsMenu) settingsMenu.classList.add('hidden');
        if (isHidden) musicMenu.classList.remove('hidden');
        else musicMenu.classList.add('hidden');
    };

    document.addEventListener('click', (e) => {
        if (musicMenu && !musicMenu.contains(e.target) && !musicButton.contains(e.target)) {
            musicMenu.classList.add('hidden');
        }
    });

    if (bgmVolumeSlider) {
        bgmVolumeSlider.addEventListener('input', (e) => {
            bgmAudio.volume = e.target.value;
        });
    }

    // double click map to generate manual high pressure system
    mapContainer.on("dblclick", (event) => {
        if (!state.showPressureField) return;

        const [mouseX, mouseY] = d3.pointer(event);
        const coords = mapProjection.invert([mouseX, mouseY]);
        if (!coords) return;
        const [lon, lat] = coords;

        const existingIndex = state.pressureSystems.lower.findIndex(s => s.isManual);

        if (existingIndex === -1) {
            const newSystem = {
                type: 'high', x: lon, y: lat,
                sigmaX: 5, sigmaY: 3, baseSigmaX: 5,
                strength: 8, baseStrength: 8,
                velocityX: 0, velocityY: 0,
                isManual: true, noiseLayers: []
            };

            const lowerSys = JSON.parse(JSON.stringify(newSystem));
            const upperSys = JSON.parse(JSON.stringify(newSystem));
            upperSys.strength = 8;

            state.pressureSystems.lower.push(lowerSys);
            state.pressureSystems.upper.push(upperSys);

            playClick();
            requestRedraw();
        }
    });

    window.addEventListener('resize', () => {
        if (state.world) {
            setupCanvases();
             if (state.cyclone.status) {
                 updateStateSiteData();
                 drawMap(mapSvg, mapProjection, state.world, state.cyclone, {
                     pathForecasts: state.pathForecasts,
                     pressureSystems: state.pressureSystems,
                     showPressureField: state.showPressureField,
                     showHumidityField: state.showHumidityField,
                     showPathForecast: state.showPathForecast,
                     showWindRadii: state.showWindRadii,
                     siteName: state.siteName,
                     siteLon: state.siteLon,
                     siteLat: state.siteLat,
                     showPathPoints: state.showPathPoints,
                     showWindField: state.showWindField,
                     month: state.currentMonth,
                     siteHistory: state.siteHistory,
                     siteData: state.currentSiteData,
                     onSiteClick: () => {
                         state.isSiteSelected = !state.isSiteSelected;
                         requestRedraw();
                     }
                 });
             }
             if (state.cyclone.status && state.cyclone.status !== 'active') {
                 drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip);
             }
        }
    });

    window.addEventListener('cycloneTrackClick', (e) => {
        selectedHistoryPointIndex = e.detail.index;
        generateJTWCButton.classList.remove('hidden');
        generateJTWCButton.classList.add('ring-2', 'ring-red-500');
        setTimeout(() => generateJTWCButton.classList.remove('ring-2', 'ring-red-500'), 300);
    });

    mapContainer.node().addEventListener('click', (e) => {
        if (e.target.tagName === 'svg' || e.target.id === 'map-container') {
            const jtwcActionButton = document.getElementById('jtwcActionButton');
            if (jtwcActionButton) jtwcActionButton.classList.add('hidden');
            selectedHistoryPointIndex = -1;

            const interactionLayer = mapSvg.select(".track-interaction-layer");
            if (!interactionLayer.empty()) {
                interactionLayer.select(".selected-circle").style("opacity", 0);
            }
            requestRedraw();
        }
    });

    window.addEventListener('cycloneTrackDeselect', () => {
        if (generateJTWCButton) generateJTWCButton.classList.add('hidden');
    });

    // JTWC Report generation logic
    generateJTWCButton.addEventListener('click', () => {
        const targetCyclone = state.selectedHistoryCyclone || state.cyclone;
        let renderIndex = selectedHistoryPointIndex;

        if (renderIndex === -1) {
            if (targetCyclone && targetCyclone.track.length > 0) {
                renderIndex = targetCyclone.track.length - 1;
                if (!state.isPaused && state.simulationInterval && !state.selectedHistoryCyclone) {
                    togglePause();
                }
            } else return;
        }
        if (renderIndex === -1 || !targetCyclone) return;

        playClick();
        jtwcModal.classList.remove('hidden');

        jtwcOutput.innerHTML = `
            <div class="flex h-[600px] w-full">
                <div class="w-40 flex-shrink-0 bg-gray-100 border-r border-gray-300 p-2 flex flex-col gap-2">
                    <div class="text-xs font-bold text-gray-500 mb-2 px-2">PRODUCTS</div>
                    <button id="jtwc-tab-graphic" class="text-left px-3 py-2 text-sm font-bold bg-white border border-gray-300 rounded shadow-sm text-cyan-700 transition-all hover:bg-gray-50">WARNING GRAPHIC</button>
                    <button id="jtwc-tab-prob34" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">WIND PROB 34KT</button>
                    <button id="jtwc-tab-prob64" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">WIND PROB 64KT</button>
                    <button id="jtwc-tab-satellite" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">SAT IMAGERY</button>
                    <button id="jtwc-tab-phase" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors">PHASE SPACE</button>
                    <div class="h-px bg-gray-300 my-1"></div>
                    <button id="jtwc-tab-station" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors flex items-center gap-2">STATION OBS</button>
                    <button id="jtwc-tab-synoptic" class="text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors flex items-center gap-2">SYNOPTIC CHART</button>
                </div>

                <div id="jtwc-content-area" class="flex-1 bg-gray-50 flex items-center justify-center overflow-auto p-4 relative">
                    <div id="jtwc-loading" class="hidden absolute inset-0 flex items-center justify-center bg-white/80 z-10 text-cyan-600 font-bold pointer-events-none">GENERATING...</div>
                </div>
            </div>
        `;

        const contentArea = document.getElementById('jtwc-content-area');
        const tabGraphic = document.getElementById('jtwc-tab-graphic');
        const tabProb34 = document.getElementById('jtwc-tab-prob34');
        const tabProb64 = document.getElementById('jtwc-tab-prob64');
        const tabSatellite = document.getElementById('jtwc-tab-satellite');
        const tabPhase = document.getElementById('jtwc-tab-phase');
        const tabStation = document.getElementById('jtwc-tab-station');
        const tabSynoptic = document.getElementById('jtwc-tab-synoptic');
        const loadingNode = document.getElementById('jtwc-loading');

        let currentCanvas = null;
        let currentMode = 'GRAPHIC';

        const showLoading = () => {
            contentArea.innerHTML = '';
            loadingNode.classList.remove('hidden');
            contentArea.appendChild(loadingNode);
        };

        const updateTabStyles = (activeTab) => {
            [tabGraphic, tabProb34, tabProb64, tabSatellite, tabPhase, tabStation, tabSynoptic].forEach(tab => {
                tab.className = tab === activeTab
                    ? "text-left px-3 py-2 text-sm font-bold bg-white border border-gray-300 rounded shadow-sm text-cyan-700 transition-all"
                    : "text-left px-3 py-2 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded transition-colors";
            });
        };

        const showGraphic = () => {
            updateTabStyles(tabGraphic);
            currentMode = 'GRAPHIC';
            showLoading();
            setTimeout(() => {
                const canvas = renderJTWCStyle(targetCyclone, renderIndex, state.world);
                canvas.className = "max-w-full max-h-full shadow-lg border border-gray-200";
                contentArea.innerHTML = '';
                contentArea.appendChild(canvas);
                currentCanvas = canvas;
            }, 10);
        };

        const showProb = (threshold) => {
            const activeTab = threshold === 64 ? tabProb64 : tabProb34;
            updateTabStyles(activeTab);
            currentMode = threshold === 64 ? 'PROB64' : 'PROB34';
            showLoading();
            setTimeout(() => {
                if (typeof renderProbabilitiesStyle === 'function') {
                    const canvas = renderProbabilitiesStyle(targetCyclone, renderIndex, state.world, threshold);
                    canvas.className = "max-w-full max-h-full shadow-lg border border-gray-200";
                    contentArea.innerHTML = '';
                    contentArea.appendChild(canvas);
                    currentCanvas = canvas;
                } else {
                    contentArea.innerText = "Error: Module not imported.";
                }
            }, 50);
        };

        const showPhaseSpace = () => {
            updateTabStyles(tabPhase);
            currentMode = 'PHASE';
            currentCanvas = null;
            showLoading();
            setTimeout(() => {
                if (typeof renderPhaseSpace === 'function') {
                    const canvas = renderPhaseSpace(targetCyclone, state.GlobalTemp);
                    canvas.className = "max-w-full max-h-full shadow-lg border border-gray-800";
                    contentArea.innerHTML = '';
                    contentArea.appendChild(canvas);
                    currentCanvas = canvas;
                } else {
                    contentArea.innerText = "Module not loaded.";
                }
            }, 50);
        };

        const showSatelliteImagery = () => {
            updateTabStyles(tabSatellite);
            currentMode = 'SATELLITE';
            currentCanvas = null;
            contentArea.innerHTML = '';

            const targetPoint = targetCyclone.track[renderIndex];
            const targetAge = renderIndex * 3;
            const cache = targetCyclone.satelliteCache || [];

            let bestShot = cache.find(s => s.age === targetAge);
            if (!bestShot && cache.length > 0) {
                bestShot = cache.reduce((prev, curr) => (Math.abs(curr.age - targetAge) < Math.abs(prev.age - targetAge) ? curr : prev));
            }

            const container = document.createElement('div');
            container.className = "w-full h-full flex flex-col items-center justify-center bg-[#1a1a1a] relative";

            if (bestShot) {
                const img = document.createElement('img');
                img.src = bestShot.img;
                img.className = "w-full h-full shadow-lg border border-gray-800 object-contain";
                container.appendChild(img);

                const infoOverlay = document.createElement('div');
                infoOverlay.className = "absolute top-4 left-4 text-white/80 font-mono text-xs bg-black/50 p-2 rounded pointer-events-none";

                const year = new Date().getFullYear();
                const month = (targetCyclone.currentMonth || 8) - 1;
                const d = new Date(Date.UTC(year, month, 1));
                d.setUTCHours(d.getUTCHours() + bestShot.age);
                const timeStr = `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCHours()).padStart(2,'0')}Z`;

                const trackData = targetCyclone.track.find((_, i) => i * 3 === bestShot.age) || targetPoint;
                const intensity = trackData ? trackData[2] : 0;
                const nameDisplay = targetCyclone.name ? targetCyclone.name.toUpperCase() : `TD ${String(state.simulationCount).padStart(2, '0')}`;

                infoOverlay.innerHTML = `
                    <div class="font-bold text-lg text-cyan-400">SATELLITE SNAPSHOT OF ${nameDisplay}</div>
                    <div>VALID: ${timeStr} (T+${bestShot.age}H)</div>
                    <div>INTENSITY: ${Math.round(intensity/5)*5} KT</div>
                    ${bestShot.age !== targetAge ? `<div class="text-yellow-400 mt-1">Note: Showing nearest img (Req: T+${targetAge}H)</div>` : ''}
                `;
                container.appendChild(infoOverlay);
            } else {
                container.innerHTML = `
                    <div class="text-center text-slate-500">
                        <i class="fa-solid fa-satellite-dish text-6xl mb-4 opacity-50"></i>
                        <p class="text-xl font-bold">NO IMAGERY AVAILABLE</p>
                        <p class="text-sm mt-2">Simulation hasn't generated satellite cache for T+${targetAge}H yet.</p>
                        <p class="text-xs text-slate-600 mt-1">Images are captured every 6 hours during simulation run.</p>
                    </div>
                `;
            }
            contentArea.appendChild(container);
        };

        const showSynopticChart = () => {
            updateTabStyles(tabSynoptic);
            currentMode = 'SYNOPTIC';
            currentCanvas = null;
            showLoading();

            const targetHour = renderIndex * 3;
            const isHistoryMode = !!state.selectedHistoryCyclone;

            const sourceSiteList = isHistoryMode ? (state.selectedHistoryCyclone.siteHistory || []) : state.siteHistory;
            const record = sourceSiteList.find(h => h.hour === targetHour);
            const sLon = record ? record.lon : state.siteLon;
            const sLat = record ? record.lat : state.siteLat;
            const sName = state.siteName || "STATION";

            let historySystem = null;

            if (isHistoryMode) {
                const pressureHistory = state.selectedHistoryCyclone.pressureHistory || [];
                const found = pressureHistory.find(h => h.age === targetHour);
                if (found) {
                    historySystem = { lower: found.lower, upper: found.upper };
                } else if (pressureHistory.length > 0) {
                    const closest = pressureHistory.reduce((prev, curr) => (Math.abs(curr.age - targetHour) < Math.abs(prev.age - targetHour) ? curr : prev));
                    if (Math.abs(closest.age - targetHour) <= 6) {
                        historySystem = { lower: closest.lower, upper: closest.upper };
                    }
                }
            } else {
                if (state.pressureHistory && state.pressureHistory.length > 0) {
                    const found = state.pressureHistory.find(h => h.age === targetHour);
                    if (found) historySystem = { lower: found.lower, upper: found.upper };
                }
                if (!historySystem) historySystem = state.pressureSystems;
            }

            if (!historySystem) {
                contentArea.innerHTML = '<div class="flex items-center justify-center h-full text-slate-400 font-bold">NO SYNOPTIC DATA FOUND</div>';
                return;
            }

            setTimeout(() => {
                if (typeof renderStationSynopticChart === 'function') {
                    const canvas = renderStationSynopticChart(targetCyclone, renderIndex, state.world, historySystem, sLon, sLat, sName);
                    canvas.className = "max-w-full max-h-full shadow-lg border border-gray-800";
                    contentArea.innerHTML = '';
                    contentArea.appendChild(canvas);
                    currentCanvas = canvas;
                } else {
                    contentArea.innerText = "Module not loaded.";
                }
            }, 50);
        };

        const showStationData = () => {
            updateTabStyles(tabStation);
            currentMode = 'STATION';
            currentCanvas = null;
            contentArea.innerHTML = '';

            const targetHour = renderIndex * 3;
            const isHistoryMode = !!state.selectedHistoryCyclone;
            const sourceList = isHistoryMode ? (state.selectedHistoryCyclone.siteHistory || []) : (state.siteHistory || []);
            const record = sourceList.find(h => h.hour === targetHour);

            if (!record) {
                contentArea.innerHTML = `
                    <div class="text-center text-slate-500 mt-20">
                        <i class="fa-solid fa-file-circle-xmark text-4xl mb-4 text-slate-300"></i>
                        <p class="font-bold">NO DATA RECORDED</p>
                        <p class="text-xs mt-2">No station measurements found for T+${targetHour}H.</p>
                        <p class="text-[10px] text-slate-400 mt-1">(Station monitoring might have been disabled)</p>
                    </div>
                `;
                return;
            }

            const localWindKt = Math.round(record.wind);
            const localPressure = Math.round(record.pressure);

            const flowAngleMath = Math.atan2(-record.v, record.u) * RAD_TO_DEG;
            let windFromDir = (flowAngleMath + 270) % 360;
            if (windFromDir < 0) windFromDir += 360;
            const localWindDirStr = directionToCompass(windFromDir);

            const dbz = record.dbz || 0;
            let conditionText = "FAIR", conditionClass = "text-slate-500", iconClass = "fa-sun";
            if (dbz >= 50) { conditionText = "VIOLENT STORM"; conditionClass = "text-purple-600"; iconClass = "fa-cloud-bolt"; }
            else if (dbz >= 35) { conditionText = "HEAVY RAIN"; conditionClass = "text-blue-700"; iconClass = "fa-cloud-showers-heavy"; }
            else if (dbz >= 15) { conditionText = "MODERATE RAIN"; conditionClass = "text-blue-500"; iconClass = "fa-cloud-rain"; }
            else if (dbz >= 5) { conditionText = "OVERCAST"; conditionClass = "text-slate-600"; iconClass = "fa-cloud"; }

            const p = targetCyclone.track[renderIndex];
            const siteLatFixed = record.lat || state.siteLat;
            const siteLonFixed = record.lon || state.siteLon;

            const distKm = calculateDistance(p[1], p[0], siteLatFixed, siteLonFixed);
            const bearingRad = Math.atan2(p[0] - siteLonFixed, p[1] - siteLatFixed);
            let bearingDeg = (bearingRad * RAD_TO_DEG);
            if (bearingDeg < 0) bearingDeg += 360;
            const bearingStr = directionToCompass(bearingDeg);

            const siteName = state.siteName || "UNNAMED STATION";
            const year = new Date().getFullYear();
            const monthIndex = (state.currentMonth || 8) - 1;
            const simDate = new Date(Date.UTC(year, monthIndex, 1));
            simDate.setUTCHours(simDate.getUTCHours() + targetHour);

            const dd = String(simDate.getUTCDate()).padStart(2, '0');
            const hh = String(simDate.getUTCHours()).padStart(2, '0');
            const validTimeStr = `${dd}/${hh}Z`;

            contentArea.innerHTML = `
                <div class="bg-white p-6 shadow-sm border border-gray-200 w-full max-w-2xl font-mono h-full flex flex-col">
                    <div class="flex justify-between items-end mb-4 border-b pb-2">
                        <div>
                            <div class="text-[10px] text-gray-400 font-bold">STATION OBS</div>
                            <div class="text-2xl font-black">${siteName.toUpperCase()}</div>
                            <div class="text-[10px] text-gray-500 mt-1 flex gap-2">
                                <span><i class="fa-solid fa-location-dot"></i> ${siteLatFixed.toFixed(2)}N, ${siteLonFixed.toFixed(2)}E</span>
                                <span><i class="fa-solid fa-clock"></i> T+${targetHour}H</span>
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="text-3xl font-black text-cyan-700">${validTimeStr}</div>
                            <div class="text-xs text-gray-400 font-bold">VALID TIME</div>
                            <button id="btn-show-obs-text" class="text-[10px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded border border-slate-300 transition-colors">
                                <i class="fa-solid fa-file-code"></i> TEXT REPORT
                            </button>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4 mb-4">
                        <div id="panel-wind" class="bg-slate-50 p-3 border-2 border-transparent hover:border-cyan-400 cursor-pointer transition-all group relative">
                            <div class="text-[10px] text-slate-400 font-bold mb-1 group-hover:text-cyan-600">WIND (CLICK FOR CHART)</div>
                            <div class="flex items-baseline gap-2">
                                <div class="text-4xl font-black text-slate-800">${localWindKt}</div>
                                <div class="text-sm font-bold text-slate-500">KT</div>
                            </div>
                            <div class="text-xs font-bold text-slate-600 mt-1 flex items-center gap-1">
                                <i class="fa-solid fa-location-arrow transform rotate-[${windFromDir + 135}deg]"></i>
                                ${localWindDirStr} <span class="text-[10px] text-slate-400 font-normal">(${Math.round(windFromDir)}°)</span>
                            </div>
                            <i class="fa-solid fa-chart-line absolute top-2 right-2 text-slate-200 group-hover:text-cyan-400"></i>
                        </div>

                        <div id="panel-pressure" class="bg-slate-50 p-3 border-2 border-transparent hover:border-yellow-400 cursor-pointer transition-all group relative">
                            <div class="text-[10px] text-slate-400 font-bold mb-1 group-hover:text-yellow-600">MSLP (CLICK FOR CHART)</div>
                            <div class="flex items-baseline gap-2">
                                <div class="text-4xl font-black text-slate-800">${localPressure}</div>
                                <div class="text-sm font-bold text-slate-500">hPa</div>
                            </div>
                            <div class="text-xs text-slate-400 mt-1">RECORDED</div>
                            <i class="fa-solid fa-chart-line absolute top-2 right-2 text-slate-200 group-hover:text-yellow-400"></i>
                        </div>
                    </div>

                    <div class="grid grid-cols-3 gap-2 text-center mb-4">
                        <div class="border p-2 rounded"><div class="text-[10px] text-gray-400">DIST</div><div class="font-bold">${Math.round(distKm)} KM</div></div>
                        <div class="border p-2 rounded"><div class="text-[10px] text-gray-400">COND</div><div class="font-bold ${conditionClass}"><i class="fa-solid ${iconClass}"></i> ${conditionText}</div></div>
                        <div class="border p-2 rounded">
                            <div class="text-[10px] text-gray-400">STORM BEARING</div>
                            <div class="font-bold text-[10px]">${bearingStr} (${Math.round(bearingDeg)}°)</div>
                        </div>
                    </div>

                    <div class="flex-1 border border-slate-100 bg-slate-50 rounded relative overflow-hidden">
                        <div id="station-chart-title" class="absolute top-2 left-2 text-[10px] font-bold text-slate-400 z-10">SELECT A PARAMETER ABOVE</div>
                        <div id="station-chart-view" class="w-full h-full"></div>
                    </div>
                </div>
            `;

            const chartContainer = "#station-chart-view";
            const titleLabel = document.getElementById('station-chart-title');
            const panelWind = document.getElementById('panel-wind');
            const panelPressure = document.getElementById('panel-pressure');
            const historySlice = sourceList.filter(h => h.hour <= targetHour);

            drawStationGraph(chartContainer, historySlice, 'wind');
            titleLabel.textContent = "PAST WIND SPEED HISTORY";
            panelWind.classList.add('border-cyan-400', 'bg-cyan-50');

            panelWind.onclick = () => {
                drawStationGraph(chartContainer, historySlice, 'wind');
                titleLabel.textContent = "WIND SPEED HISTORY";
                panelWind.classList.add('border-cyan-400', 'bg-cyan-50');
                panelPressure.classList.remove('border-yellow-400', 'bg-yellow-50');
            };

            panelPressure.onclick = () => {
                drawStationGraph(chartContainer, historySlice, 'pressure');
                titleLabel.textContent = "MSLP HISTORY";
                panelPressure.classList.add('border-yellow-400', 'bg-yellow-50');
                panelWind.classList.remove('border-cyan-400', 'bg-cyan-50');
            };

            document.getElementById('btn-show-obs-text').onclick = () => {
                const container = document.querySelector(chartContainer);
                titleLabel.textContent = "FULL OBSERVATION LOG (CHRONOLOGICAL)";

                const baseYear = new Date().getFullYear();
                const baseMonthIndex = (state.currentMonth || 8) - 1;

                const logLines = historySlice.map(h => {
                    const tDate = new Date(Date.UTC(baseYear, baseMonthIndex, 1));
                    tDate.setUTCHours(tDate.getUTCHours() + h.hour);

                    const yyyy = tDate.getUTCFullYear();
                    const mm = String(tDate.getUTCMonth() + 1).padStart(2, '0');
                    const dNum = String(tDate.getUTCDate()).padStart(2, '0');
                    const hr = String(tDate.getUTCHours()).padStart(2, '0');
                    const timeStr = `${yyyy}${mm}${dNum}${hr}`;

                    const w = Math.round(h.wind);
                    const p = Math.round(h.pressure);

                    const angleMath = Math.atan2(-h.v, h.u) * RAD_TO_DEG;
                    let dirDeg = (angleMath + 270) % 360;
                    if (dirDeg < 0) dirDeg += 360;
                    const dirStr = directionToCompass(dirDeg);

                    const prec = Math.max(0, ((h.dbz || 0) - 15) * (Math.random() + 1.8)).toFixed(1);

                    return `${timeStr}  ${String(w).padStart(3)}KT  ${dirStr.padEnd(3)}  ${p}hPa  ${prec.padStart(5)}MM`;
                }).join('\n');

                container.innerHTML = `
                    <div class="w-full h-full p-2 bg-slate-50 border border-slate-200 rounded">
                        <textarea class="w-full h-full bg-transparent font-mono text-xs md:text-sm text-slate-700 resize-none focus:outline-none leading-relaxed p-2" readonly spellcheck="false">${logLines}</textarea>
                    </div>
                `;

                setTimeout(() => {
                    const textarea = container.querySelector('textarea');
                    if (textarea) textarea.scrollTop = textarea.scrollHeight;
                }, 10);
            };
        };

        tabGraphic.onclick = showGraphic;
        tabProb34.onclick = () => showProb(34);
        tabProb64.onclick = () => showProb(64);
        tabSatellite.onclick = showSatelliteImagery;
        tabPhase.onclick = showPhaseSpace;
        tabStation.onclick = showStationData;
        tabSynoptic.onclick = showSynopticChart;

        const saveBtn = document.getElementById('saveJtwcImage');
        saveBtn.onclick = () => {
            if (currentMode === 'SATELLITE') {
                const name = targetCyclone.name || 'STORM';
                const timeTag = `T${renderIndex * 3}`;
                const imgElement = contentArea.querySelector('img');
                if (imgElement && imgElement.src) {
                    const link = document.createElement('a');
                    link.download = `SAT_${name}_${timeTag}.png`;
                    link.href = imgElement.src;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                } else {
                    alert("No image to save!");
                }
                return;
            }

            if (currentCanvas) {
                const link = document.createElement('a');
                const name = targetCyclone.name || 'STORM';
                link.download = `JTWC_${name}_${currentMode}_T${renderIndex * 3}.png`;
                link.href = currentCanvas.toDataURL();
                link.click();
            } else {
                alert("No image to save!");
            }
        };

        let timelineBtn = document.getElementById('saveTimelineVideo');
        if (!timelineBtn) {
            timelineBtn = document.createElement('button');
            timelineBtn.id = 'saveTimelineVideo';
            timelineBtn.className = "px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold transition-colors flex items-center gap-2";
            timelineBtn.innerHTML = '<i class="fa-solid fa-film"></i> SAVE TIMELINE';
            if (saveBtn && saveBtn.parentNode) {
                saveBtn.parentNode.insertBefore(timelineBtn, saveBtn);
            }
        }

        timelineBtn.onclick = async () => {
            if (currentMode !== 'GRAPHIC' && currentMode !== 'SYNOPTIC') {
                alert("Timeline video is only available for WARNING GRAPHIC and SYNOPTIC CHART tabs.");
                return;
            }

            const track = targetCyclone.track;
            if (!track || track.length === 0) return;

            const timelineIndices = track.map((_, i) => i).filter(i => (i * 3) % 6 === 0);
            if (timelineIndices.length === 0) {
                alert("Not enough track points for a timeline.");
                return;
            }

            const loadingBadge = document.createElement('div');
            loadingBadge.className = "fixed top-4 right-4 bg-red-600 text-white px-4 py-2 rounded shadow-xl z-[9999] font-bold animate-pulse flex items-center gap-2";
            loadingBadge.innerHTML = '<i class="fa-solid fa-circle text-xs"></i> RECORDING TIMELINE...';
            document.body.appendChild(loadingBadge);

            timelineBtn.disabled = true;
            timelineBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> PROCESSING...';

            try {
                const recWidth = 1600;
                const recHeight = 1200;
                const canvas = document.createElement('canvas');
                canvas.width = recWidth;
                canvas.height = recHeight;
                const ctx = canvas.getContext('2d');

                ctx.fillStyle = "white";
                ctx.fillRect(0, 0, recWidth, recHeight);

                const stream = canvas.captureStream(30);
                const recorder = new MediaRecorder(stream, {
                    mimeType: 'video/webm;codecs=vp9',
                    videoBitsPerSecond: 36000000
                });

                const chunks = [];
                recorder.ondataavailable = e => chunks.push(e.data);
                recorder.start();

                for (let i = 0; i < timelineIndices.length; i++) {
                    const idx = timelineIndices[i];
                    const targetHour = idx * 3;

                    loadingBadge.innerHTML = `<i class="fa-solid fa-circle text-xs"></i> RECORDING FRAME ${i+1}/${timelineIndices.length}`;

                    let frameCanvas = null;

                    if (currentMode === 'GRAPHIC') {
                        if (typeof renderJTWCStyle === 'function') {
                            frameCanvas = renderJTWCStyle(targetCyclone, idx, state.world);
                        }
                    } else if (currentMode === 'SYNOPTIC') {
                        const isHistoryMode = !!state.selectedHistoryCyclone;
                        let historySystem = null;

                        if (isHistoryMode) {
                            const pressureHistory = state.selectedHistoryCyclone.pressureHistory || [];
                            const found = pressureHistory.find(h => h.age === targetHour);
                            if (found) {
                                historySystem = { lower: found.lower, upper: found.upper };
                            } else if (pressureHistory.length > 0) {
                                const closest = pressureHistory.reduce((prev, curr) =>
                                    (Math.abs(curr.age - targetHour) < Math.abs(prev.age - targetHour) ? curr : prev)
                                );
                                if (Math.abs(closest.age - targetHour) <= 6) {
                                    historySystem = { lower: closest.lower, upper: closest.upper };
                                }
                            }
                        } else {
                            if (state.pressureHistory) {
                                const found = state.pressureHistory.find(h => h.age === targetHour);
                                if (found) historySystem = { lower: found.lower, upper: found.upper };
                            }
                            if (!historySystem) historySystem = state.pressureSystems;
                        }

                        const sourceList = isHistoryMode ? (state.selectedHistoryCyclone.siteHistory || []) : state.siteHistory;
                        const record = sourceList.find(h => h.hour === targetHour);
                        const sLon = record ? record.lon : state.siteLon;
                        const sLat = record ? record.lat : state.siteLat;
                        const sName = state.siteName || "STATION";

                        if (historySystem && typeof renderStationSynopticChart === 'function') {
                            frameCanvas = renderStationSynopticChart(targetCyclone, idx, state.world, historySystem, sLon, sLat, sName);
                        }
                    }

                    if (frameCanvas) {
                        ctx.fillStyle = "white";
                        ctx.fillRect(0, 0, recWidth, recHeight);
                        const scale = Math.min(recWidth / frameCanvas.width, recHeight / frameCanvas.height);
                        const w = frameCanvas.width * scale;
                        const h = frameCanvas.height * scale;
                        const x = (recWidth - w) / 2;
                        const y = (recHeight - h) / 2;
                        ctx.drawImage(frameCanvas, x, y, w, h);
                    }

                    await new Promise(r => setTimeout(r, 400));
                }

                recorder.stop();

                await new Promise(resolve => {
                    recorder.onstop = () => {
                        const blob = new Blob(chunks, { type: 'video/webm' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        const name = (targetCyclone.name || "STORM").toUpperCase();
                        a.download = `${name}_${currentMode}_TIMELINE.webm`;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        resolve();
                    };
                });

            } catch (err) {
                console.error("Video generation failed:", err);
                alert("Failed to generate video. Check console for details.");
            } finally {
                document.body.removeChild(loadingBadge);
                timelineBtn.disabled = false;
                timelineBtn.innerHTML = '<i class="fa-solid fa-film"></i> SAVE TIMELINE';
            }
        };

        showGraphic();
    });

    closeJtwcModal.addEventListener('click', () => jtwcModal.classList.add('hidden'));

    if (catButton && newsModal) {
        catButton.addEventListener('click', () => {
            if (!state.cyclone || !state.cyclone.track || state.cyclone.track.length < 2) {
                alert("No simulation found.");
                return;
            }

            if (typeof playClick === 'function') playClick();

            newsModal.classList.remove('hidden');

            const ticker = document.getElementById('newsTicker');
            const name = (state.cyclone.name || "UNNAMED").toUpperCase();
            const catName = getEnglishCategoryName(state.cyclone.intensity, state.cyclone.isExtratropical, state.cyclone.isSubtropical, basinSelector.value);
            const wind = Math.round(state.cyclone.intensity);
            const pressure = Math.round(windToPressure(state.cyclone.intensity, state.cyclone.circulationSize, basinSelector.value));

            let landfallAlert = "";

            if (state.pathForecasts && state.pathForecasts.length > 0) {
                const forecastTrack = state.pathForecasts[0].track;
                let willLandfall = false;

                for (let i = 0; i < forecastTrack.length; i++) {
                    const p = forecastTrack[i];
                    if (getLandStatus(p[0], p[1]) === 'land') {
                        willLandfall = true;
                        break;
                    }
                }

                if (willLandfall) {
                    landfallAlert = "AND FORECAST INDICATES LANDFALL IMMINENT IN THE NEXT 72 HOURS.";
                }
            }

            const newsItem = `UPDATED: ${catName} "${name}" LOCATED AT ${state.cyclone.lat.toFixed(1)}N ${state.cyclone.lon.toFixed(1)}E, MAX WINDS: ${Math.round(wind/5)*5} KT, MIN PRESSURE: ${pressure} HPA. ${landfallAlert}`;
            ticker.textContent = newsItem;

            if (stopNewsAnimation) stopNewsAnimation();
            stopNewsAnimation = startNewsAnimation(newsCanvas, state.world, state.cyclone, state.pathForecasts, basinSelector.value, state.simulationCount, state.pressureSystems, state.currentMonth, state.GlobalTemp, state.GlobalShear);
        });

        const closeNews = () => {
            newsModal.classList.add('hidden');
            if (stopNewsAnimation) {
                stopNewsAnimation();
                stopNewsAnimation = null;
            }
        };

        closeNewsModal.addEventListener('click', closeNews);

        newsModal.addEventListener('click', (e) => {
            if (e.target === newsModal) closeNews();
        });
    }

    document.addEventListener('keydown', (event) => {
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        if (event.code === 'Space') {
            event.preventDefault();
            togglePause();
        }

        if (event.code === 'KeyF') {
            if (forecastContainer) {
                state.showIntensityChart = !state.showIntensityChart;

                if (state.showIntensityChart) {
                    forecastContainer.classList.remove('hidden');
                    if (state.cyclone && state.cyclone.track && state.cyclone.track.length > 0) {
                        setTimeout(() => {
                            drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip, chartMode, basinSelector.value);
                        }, 10);
                    }
                } else {
                    forecastContainer.classList.add('hidden');
                }

                if (typeof playClick === 'function') playClick();
            }
        }

        if (event.code === 'KeyS') {
            generateButton.click();
        }

        const toggleLegend = (elementId, show) => {
            const el = document.getElementById(elementId);
            if (!el) return;
            if (show) {
                el.classList.remove('hidden');
                requestAnimationFrame(() => el.setAttribute('data-show', 'true'));
            } else {
                el.setAttribute('data-show', 'false');
                setTimeout(() => el.classList.add('hidden'), 300);
            }
        };

        const updateRadarUI = () => {
            toggleLegend('radar-legend', state.radarMode);
            toggleLegend('doppler-legend', state.dopplerMode);
            requestRedraw();
        };

        if (event.code === 'KeyR') {
            if (state.dopplerMode) {
                state.dopplerMode = false;
                state.radarMode = true;
            } else {
                state.radarMode = !state.radarMode;
            }
            updateRadarUI();
        }

        if (event.code === 'KeyD') {
            if (state.radarMode) {
                state.radarMode = false;
                state.dopplerMode = true;
            } else {
                state.dopplerMode = !state.dopplerMode;
            }
            updateRadarUI();
        }

        if (event.key === '1') changeSimulationSpeed(50);
        if (event.key === '2') changeSimulationSpeed(200);
        if (event.key === '3') changeSimulationSpeed(600);
        if (event.code === 'KeyV') toggleLeftPanel();
    });

    tabKt.addEventListener('click', () => {
        chartMode = 'kt';
        updateTabUI();
        if (state.cyclone && state.cyclone.track) {
            drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip, 'kt', basinSelector.value);
        }
    });

    tabHpa.addEventListener('click', () => {
        chartMode = 'hpa';
        updateTabUI();
        if (state.cyclone && state.cyclone.track) {
            drawHistoricalIntensityChart(chartContainer, state.cyclone.track, tooltip, 'hpa', basinSelector.value);
        }
    });

    helpButton.addEventListener('click', () => {
        playClick();
        helpModal.classList.remove('hidden');
        setTimeout(() => {
            helpModal.classList.remove('opacity-0');
            helpModal.querySelector('div').classList.remove('scale-95');
            helpModal.querySelector('div').classList.add('scale-100');
        }, 10);
    });

    function hideHelp() {
        helpModal.classList.add('opacity-0');
        helpModal.querySelector('div').classList.add('scale-95');
        helpModal.querySelector('div').classList.remove('scale-100');
        setTimeout(() => { helpModal.classList.add('hidden'); }, 300);
    }

    closeHelpModal.addEventListener('click', () => {
        playClick();
        hideHelp();
    });

    sfxButton.addEventListener('click', () => {
        const isMuted = toggleSFX();
        if (isMuted) {
            sfxIcon.classList.remove('fa-volume-high');
            sfxIcon.classList.add('fa-volume-xmark');
            sfxButton.classList.replace('text-cyan-400', 'text-slate-500');
        } else {
            sfxIcon.classList.remove('fa-volume-xmark');
            sfxIcon.classList.add('fa-volume-high');
            sfxButton.classList.replace('text-slate-500', 'text-cyan-400');
        }
        if (typeof playClick === 'function') playClick();
    });

    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) hideHelp();
    });
});
