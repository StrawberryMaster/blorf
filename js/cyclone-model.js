/**
 * js/cyclone-model.js
 * Core logic and atmospheric dynamics engine
 */
import { NAME_LISTS, getSST, getPressureAt, normalizeLongitude, calculateDistance, windToPressure } from './utils.js';
import { getElevationAt, getLandStatus } from './terrain-data.js';
import { calculateBackgroundHumidity } from './visualization.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const KM_PER_DEG = 111.32;
const INV_KM_PER_DEG = 1 / KM_PER_DEG;

const basinConfig = {
    'WPAC': { lon: { min: 100, max: 180 }, lat: { min: 5, max: 25 } },  // West Pacific
    'EPAC': { lon: { min: 180, max: 260 }, lat: { min: 5, max: 20 } },  // East Pacific (140W to 80W)
    'NATL': { lon: { min: 260, max: 350 }, lat: { min: 6, max: 32 } },  // North Atlantic (75W to 10W)
    'NIO':  { lon: { min: 60,  max: 100 }, lat: { min: 5, max: 25 } },  // North Indian
    'SHEM': { lon: { min: 140, max: 200 }, lat: { min: -15, max: -5 } }, // South Pacific
    'SIO':  { lon: { min: 30,  max: 140 }, lat: { min: -15, max: -5 } }, // South Indian
    'SATL': { lon: { min: -50, max: 15 },  lat: { min: -25, max: -10 } } // South Atlantic
};

function calculateLayerWind(lon, lat, systems) {
    const dDeg = 0.5;
    const latRad = lat * DEG_TO_RAD;
    const f = 2 * 7.292115e-5 * Math.sin(latRad);
    
    const effectiveF = Math.abs(f) < 5e-5 ? (f >= 0 ? 5e-5 : -5e-5) : f; 

    const p_x_plus = getPressureAt(lon + dDeg, lat, systems, false);
    const p_x_minus = getPressureAt(lon - dDeg, lat, systems, false);
    const p_y_plus = getPressureAt(lon, lat + dDeg, systems, false);
    const p_y_minus = getPressureAt(lon, lat - dDeg, systems, false);

    const gradX = p_x_plus - p_x_minus;
    const gradY = p_y_plus - p_y_minus;

    const scale = 6.0;
    const u = -gradY * scale / effectiveF * 0.0001; 
    const v =  gradX * scale / effectiveF * 0.0001;
    return { u, v };
}

export function getWindVectorAt(lon, lat, month, cyclone, pressureSystems) {
    let k = 1.0;
    let alphaDeg = 15;
    const landInfo = getLandStatus(lon, lat);
    const isLand = landInfo ? landInfo.isLand : false;
    
    if (isLand) {
        const elevation = getElevationAt(lon, lat) || 0;
        k = Math.max(0.4, 0.8 - (elevation / 1700));
        alphaDeg = Math.min(55, 15 + (elevation / 17));
    }

    const inflowAngle = alphaDeg * DEG_TO_RAD;
    const envWind = calculateLayerWind(lon, lat, pressureSystems.lower);
    
    let u_vortex = 0, v_vortex = 0;
    let u_trans = 0, v_trans = 0;

    if (cyclone.status === 'active') {
        const dist = calculateDistance(lat, lon, cyclone.lat, cyclone.lon);
        const RMW = 5 + cyclone.circulationSize * 0.125;
        const outerRadius = cyclone.circulationSize * 4.0; 

        if (dist < outerRadius) {
            let vortexSpeed = 0;
            const maxWind = cyclone.intensity;

            if (dist < RMW) {
                vortexSpeed = maxWind * (dist / RMW);
            } else {
                const decayExponent = 0.80 - cyclone.circulationSize * 0.0002;
                const rawSpeed = maxWind * Math.pow(RMW / dist, decayExponent);
                
                // outer decay fade
                let fade = 1;
                const fadeStart = outerRadius * 0.35;
                if (dist > fadeStart) {
                    const t = (dist - fadeStart) / (outerRadius - fadeStart);
                    fade = (Math.exp(-2*t) - Math.exp(-2)) / (1 - Math.exp(-2));
                }
                vortexSpeed = rawSpeed * fade;
            }

            const dx = lon - cyclone.lon;
            const dy = lat - cyclone.lat;
            const angleToCenter = Math.atan2(dy, dx);
            
            // inflow angle offset (hemisphere dependent)
            const rotationOffset = (cyclone.lat >= 0) ? (Math.PI / 2 + inflowAngle) : (-Math.PI / 2 - inflowAngle);
            const windAngle = angleToCenter + rotationOffset;

            u_vortex = Math.cos(windAngle) * vortexSpeed;
            v_vortex = Math.sin(windAngle) * vortexSpeed;
            
            const moveSpeed = cyclone.speed;
            const moveAngleMath = ((450 - cyclone.direction) % 360) * DEG_TO_RAD;
            const asymmetryFactor = 0.6;
            
            u_trans = Math.cos(moveAngleMath) * moveSpeed * asymmetryFactor;
            v_trans = Math.sin(moveAngleMath) * moveSpeed * asymmetryFactor;
            
            let transDecay = 1.0;
            if (dist > RMW) {
                transDecay = Math.max(0, 1 - (dist - RMW) / (outerRadius - RMW));
            }
            
            u_trans *= transDecay;
            v_trans *= transDecay;
        }
    }

    const finalU = envWind.u + u_vortex * k + u_trans;
    const finalV = envWind.v + v_vortex * k + v_trans;

    return { 
        u: finalU, 
        v: finalV, 
        magnitude: Math.hypot(finalU, finalV) 
    };
}

export function initializeCyclone(world, month, basin = 'WPAC', globalTemp, globalShear, customLon = null, customLat = null) {
    let lat, lon, isOverLand;
    let useCustomCoords = (customLon !== null && customLat !== null);
    
    if (useCustomCoords) {
        isOverLand = world.features.some(feature => d3.geoContains(feature, [customLon, customLat]));
        if (isOverLand) {
            console.warn(`Custom coordinates (${customLon}, ${customLat}) are on land, falling back to random generation`);
            useCustomCoords = false;
        } else {
            lon = customLon;
            lat = customLat;
        }
    }
    
    if (!useCustomCoords) {
        const selectedBasin = basinConfig[basin] || basinConfig['WPAC'];
        const lonRange = selectedBasin.lon;
        const latBaseRange = selectedBasin.lat;

        const seasonalFactor = (Math.cos((month - 8) * (Math.PI / 6)) + 1) / 2; // 0 to 1
        const latRangeSpan = latBaseRange.max - latBaseRange.min;
        const hem = latBaseRange.max > 0 ? 1 : -1;
        
        const seasonalShift = (latRangeSpan / 4) * (seasonalFactor - 0.5);
        const tempShift = hem * Math.max(0, (globalTemp / 2.89 - 100));
        
        const currentMinLat = latBaseRange.min + seasonalShift + tempShift;
        const currentMaxLat = latBaseRange.max + 4 * seasonalShift + tempShift;
        const latSpan = currentMaxLat - currentMinLat;

        let sst;
        // don't spawn on land or in cold water
        do {
            lat = currentMinLat + Math.random() * latSpan;
            lon = lonRange.min + Math.random() * (lonRange.max - lonRange.min);
            const status = getLandStatus(lon, lat);
            isOverLand = status.isLand;
            sst = getSST(lat, lon, month, globalTemp);
        } while (isOverLand || sst < 25.4);
    }

    const initialSST = getSST(lat, lon, month, globalTemp);
    
    let isSubtropical = false;
    let subtropicalTransitionTime = 0;
    if (initialSST < 27.5 && Math.random() < 0.75 && (lon > 122 || lon < 40)) {
        isSubtropical = true;
        subtropicalTransitionTime = Math.floor(Math.random() * 25) * 3;
    }

    let isMonsoonDepression = false;
    let monsoonDepressionEndTime = 0;
    if (Math.random() < (0.2 + globalTemp / 72.25 - 4) && lat > 0) {
        isMonsoonDepression = true;
        monsoonDepressionEndTime = Math.floor(Math.random() * 50) * 3;
    }

    return {
        lat, lon,
        intensity: 23 + Math.random() * 2,
        direction: Math.random() * 360,
        speed: 10 + Math.random() * 5,
        basin,
        age: 0,
        shearEventActive: false,
        shearEventEndTime: 0,
        shearEventMagnitude: 0,
        track: [],
        status: 'active',
        isTransitioning: false,
        isLand: isOverLand || false,
        isExtratropical: false,
        isSubtropical, subtropicalTransitionTime,
        isMonsoonDepression, monsoonDepressionEndTime,
        extratropicalStage: 'none',
        extratropicalDevelopmentEndTime: 0,
        extratropicalMaxIntensity: 0,
        upwellingCoolingEffect: 0,
        isERCActive: false,
        ercState: 'none',
        ercEndTime: 0,
        ercMpiReduction: 0,
        ercSizeFactor: 1.0,
        circulationSize: 150 + Math.random() * 350,
        r34: 0, r50: 0, r64: 0,
        forecastLogs: {},
        ace: 0
    };
}

export function initializePressureSystems(cyclone, month) {
    if (typeof month !== 'number' || !Number.isFinite(month)) month = 8;
    
    const tempAllSystems = [];
    const seasonalFactor = (Math.cos((month - 8) * (Math.PI / 6)) + 1) / 2;
    const baseLat = cyclone.lat; 
    const baseLon = cyclone.lon; 

    // helper to spawn a system
    const addSys = (type, x, y, bx, sx, sy, st, bst, vx, vy, op, os, oa, layers = []) => {
        tempAllSystems.push({
            type, x, y, baseSigmaX: bx, sigmaX: sx, sigmaY: sy, 
            strength: st, baseStrength: bst, velocityX: vx, velocityY: vy,
            oscillationPhase: op, oscillationSpeed: os, oscillationAmount: oa, noiseLayers: layers
        });
    };

    // tropical lows & equatorial features
    addSys('high', 140, 1 + (Math.random() - 0.5) * 5, 300, 300, 10 + Math.random() * 4, -(10 + Math.random() * 3), -(10 + Math.random() * 3), (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, Math.random() * Math.PI * 2, 0.01 + Math.random() * 0.01, 0.1);
    addSys('low', 120, 10 + (Math.random() - 0.5) * 5, 70, 70, 20 + Math.random() * 4, -(5 + Math.random() * 3) * (0.5+0.5*seasonalFactor), -(5 + Math.random() * 3) * (0.5+0.5*seasonalFactor), (Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01, Math.random() * Math.PI * 2, 0.01 + Math.random() * 0.01, 0.01);

    // subtropical highs (WPac, Atlantic, Hawaii)
    addSys('high', 150 + (Math.random() - 0.5) * 50, 26 + (Math.random() - 0.5) * 8 + 14 * seasonalFactor, 25 + Math.random() * 30, 0, 10 + Math.random() * 15, 15 + Math.random() * 6, 15 + Math.random() * 6, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, 0.02 + Math.random() * 0.01, 0.2 + Math.random() * 0.5);
    addSys('high', 115 + (Math.random() - 0.5) * 50, 23 + (Math.random() - 0.5) * 10 + 14 * seasonalFactor, 30 + Math.random() * 25, 0, 5 + Math.random() * 25, 8 + Math.random() * 11, 8 + Math.random() * 11, (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.6, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.05, 0.25 + Math.random() * 0.3);
    addSys('high', 50 + (Math.random() - 0.5) * 15, 24 + (Math.random() - 0.5) * 10 + 12 * seasonalFactor, 30 + Math.random() * 10, 0, 10 + Math.random() * 8, 10 + Math.random() * 8, 10 + Math.random() * 8, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);
    addSys('high', -140 + (Math.random() - 0.5) * 40, 20 + (Math.random() - 0.5) * 20 + 6 * seasonalFactor, 40 + Math.random() * 25, 0, 13 + Math.random() * 13, 20 + Math.random() * 12, 20 + Math.random() * 12, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.005 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);
    addSys('high', -30 + (Math.random() - 0.5) * 15, 30 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor, 50 + Math.random() * 10, 0, 10 + Math.random() * 10, 22 + Math.random() * 6, 22 + Math.random() * 6, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);

    // southern hemisphere highs
    addSys('high', 75 + (Math.random() - 0.5) * 50, -22 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor, 40 + Math.random() * 60, 0, 5 + Math.random() * 10, 20 + Math.random() * 6, 20 + Math.random() * 6, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);
    addSys('high', 150 + (Math.random() - 0.5) * 50, -22 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor, 15 + Math.random() * 35, 0, 5 + Math.random() * 10, 18 + Math.random() * 6, 18 + Math.random() * 6, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);
    addSys('high', -30 + (Math.random() - 0.5) * 50, -22 + (Math.random() - 0.5) * 10 + 6 * seasonalFactor, 15 + Math.random() * 20, 0, 5 + Math.random() * 10, 15 + Math.random() * 6, 15 + Math.random() * 6, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);

    // polar & local lows
    addSys('high', -60 + (Math.random() - 0.5) * 15, 72 + (Math.random() - 0.5) * 10, 250, 250, 10 + Math.random() * 5, 25 + Math.random() * 6, 25 + Math.random() * 6, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, Math.random() * Math.PI * 2, 0.025 + Math.random() * 0.01, 0.25 + Math.random() * 0.2);
    addSys('high', 100 + (Math.random() - 0.5) * 5, 20 + (Math.random() - 0.5) * 5, 5, 5, 3 + Math.random() * 2, 6 + Math.random() * 6, 6 + Math.random() * 6, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.4, 0, 0, 0);

    // random dynamic systems
    const numLows = 2 + Math.floor(Math.random() * 11);
    for (let i = 0; i < numLows; i++) {
        const yPos = baseLat > 0 ? Math.max(10, (Math.random() - 0.2) * 25 + baseLat) : Math.min(-10, (Math.random() - 0.7) * 20 + baseLat);
        addSys('low', (Math.random() - 0.5) * 60 + baseLon, yPos, 0, 1 + Math.random() * 3, 1 + Math.random() * 4, -4 + Math.random() * 2, -4 + Math.random() * 2, 0.5 - Math.random() * 1, (Math.random() - 0.5) * 0.1, 0, 0, 0, [
            { offsetX: 0, offsetY: 0, freqX: 5, freqY: 5, amplitude: 0.1 }, { offsetX: 0, offsetY: 0, freqX: 1, freqY: 1, amplitude: Math.random() * 0.1 }
        ]);
    }

    const numHighs = Math.floor(Math.random() * 2);
    for (let i = 0; i < numHighs; i++) {
        const yPos = baseLat > 0 ? Math.max(15, (Math.random() - 1) * 5 + baseLat) : Math.min(-15, (Math.random() + 1) * 5 + baseLat);
        addSys('high', (Math.random() - 0.5) * 60 + baseLon, yPos, 0, 2 + Math.random() * 4, 2 + Math.random() * 1, 1 + Math.random() * 10, 1 + Math.random() * 10, 0.5 - Math.random() * 1, (Math.random() - 0.5) * 0.1, 0, 0, 0);
    }

    const isWinterSeason = (month >= 10 || month <= 3);
    if (!isWinterSeason && Math.random() < 0.95) {
        addSys('low', 85 + (Math.random() - 0.5) * 15, 25 + (Math.random() - 0.5) * 5, 0, 30 + Math.random() * 3, 10, -10 - Math.random() * 5, -10 - Math.random() * 5, (Math.random()-0.5) * 0.2, Math.random() * -1.0, 0, 0, 0);
    }

    // subtropical lows (north & south)
    const subNorthHighs = tempAllSystems.filter(p => p.strength > 0 && p.y > 10 && p.y < 45);
    const meanSubLat = subNorthHighs.length > 0 ? subNorthHighs.reduce((sum, p) => sum + p.y, 0) / subNorthHighs.length : 45;
    addSys('high', 150, meanSubLat + 18 + (Math.random() - 0.5) * 4, 250, 250, 8 + Math.random() * 5, -(65 + Math.random() * 10), -(65 + Math.random() * 10), (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.1, Math.random() * Math.PI * 2, 0.015 + Math.random() * 0.01, 0.15);

    const subSouthHighs = tempAllSystems.filter(p => p.strength > 0 && p.y < -10 && p.y > -40);
    const meanSubLatS = subSouthHighs.length > 0 ? subSouthHighs.reduce((sum, p) => sum + p.y, 0) / subSouthHighs.length : -40;
    addSys('high', 150, -35 - Math.random() * 5, 250, 250, 5 + Math.random() * 5, -(40 + Math.random() * 10), -(40 + Math.random() * 10), (Math.random() - 0.5) * 0.2, (Math.random() - 0.5) * 0.1, Math.random() * Math.PI * 2, 0.015 + Math.random() * 0.01, 0.15);

    // process double layers (upper/lower)
    const upperSystems = [];
    const lowerSystems = [];

    tempAllSystems.forEach(sys => {
        const upperSys = { ...sys };
        const lowerSys = { ...sys };
        
        if (sys.type === 'high') {
            upperSys.strength *= 0.6;
            lowerSys.strength *= 0.4;
        } else {
            upperSys.strength *= 0.4; 
            lowerSys.strength *= 0.5;
        }

        // random structural tilt
        upperSys.x += (Math.random() - 0.5) * 2;
        lowerSys.x += (Math.random() - 0.5) * 2;

        upperSystems.push(upperSys);
        lowerSystems.push(lowerSys);
    });

    const systemsObj = { upper: upperSystems, lower: lowerSystems };
    updatePressureSystems(systemsObj);
    return systemsObj;
}

export function updatePressureSystems(systemsObj, month) {
    const updateList = (list) => {
        for (let i = list.length - 1; i >= 0; i--) {
            const cell = list[i];
            
            cell.x += cell.velocityX;
            cell.y += cell.velocityY;
            
            // handle cold surges
            if (cell.isColdSurge) {
                if (cell.y < 30) {
                    const decay = Math.max(0, (cell.y - 10) / 20);
                    cell.strength *= 0.96 * decay;
                    if (cell.sigmaX) cell.sigmaX *= 1.02; 
                    if (cell.sigmaY) cell.sigmaY *= 0.98;
                }
                if (cell.strength < 1.5 || cell.y < 5) {
                    list.splice(i, 1);
                    continue;
                }
            } else {
                if (cell.x > 360) cell.x -= 360;
                if (cell.x < 0) cell.x += 360;
            }

            if (cell.oscillationSpeed) {
                cell.oscillationPhase = (cell.oscillationPhase || 0) + cell.oscillationSpeed;
                const stretch = Math.sin(cell.oscillationPhase) * cell.oscillationAmount;
                if (cell.baseSigmaX) {
                    cell.sigmaX = cell.baseSigmaX * (1 + stretch);
                }
            }
        }
    };

    if (systemsObj.upper) updateList(systemsObj.upper);
    
    if (systemsObj.lower) {
        updateList(systemsObj.lower);
        
        // cold surge generation
        const isWinter = (month >= 10 || month <= 3);
        const activeSurges = systemsObj.lower.filter(s => s.isColdSurge).length;

        if (isWinter && activeSurges < 1 && Math.random() < 0.1) {
            systemsObj.lower.push({
                type: 'high',
                isColdSurge: true,
                x: 100 + Math.random() * 15, 
                y: 42 + Math.random() * 5,
                baseSigmaX: 6, sigmaX: 6, sigmaY: 8 + Math.random() * 5,
                strength: 30 + Math.random() * 15,
                velocityX: 0.15 + Math.random() * 0.1,
                velocityY: -0.2 - Math.random() * 0.2, 
                oscillationSpeed: 0, noiseLayers: []
            });
        }
    }
    
    return systemsObj;
}

export function updateFrontalZone(pressureSystemsObj, month) {
    const list = Array.isArray(pressureSystemsObj) ? pressureSystemsObj : pressureSystemsObj.upper;
    const highs = list.filter(p => p.strength > 8 && p.y > 10);
    if (highs.length === 0) return { latitude: 35 };
    
    const avgLat = highs.reduce((sum, p) => sum + p.y, 0) / highs.length;
    return { latitude: avgLat + 8 * Math.cos((month - 8) * (Math.PI / 6)) + 3 * Math.random() - 11 };
}

export function calculateSteering(lon, lat, pressureSystemsObj, bias = { u: 0, v: 0 }) {
    const windUpper = calculateLayerWind(lon, lat, pressureSystemsObj.upper);
    const windLower = calculateLayerWind(lon, lat, pressureSystemsObj.lower);

    // deep layer mean
    const weightUpper = 0.8;
    const weightLower = 0.2;

    const steerU = 0.7 * (windUpper.u * weightUpper + windLower.u * weightLower) + bias.u;
    const steerV = 0.7 * (windUpper.v * weightUpper + windLower.v * weightLower) + bias.v;

    // beta drift
    const latRad = lat * DEG_TO_RAD;
    const betaFactor = Math.sin(latRad < 0 ? 1.2 * latRad - (Math.PI/12) : 1.2 * latRad + (Math.PI/12));
    const betaU = -0.6 * betaFactor; 
    const betaV = 4.4 * betaFactor;

    // shear vector
    const shearU = windUpper.u - windLower.u;
    const shearV = windUpper.v - windLower.v;

    return { 
        steerU: steerU + betaU, 
        steerV: steerV + betaV,
        shearU,
        shearV
    };
}

export function updateCycloneState(cyclone, pressureSystems, frontalZone, world, month, globalTemp, globalShearSetting, nameIndex) {
    let updatedCyclone = { ...cyclone };
    updatedCyclone.age += 3; // step 3 hours

    // ACE calculation
    if (updatedCyclone.age % 6 === 0 && updatedCyclone.intensity >= 34 && !updatedCyclone.isExtratropical) {
        updatedCyclone.ace += (updatedCyclone.intensity ** 2) / 10000;
    }

    if (updatedCyclone.isMonsoonDepression && updatedCyclone.age >= updatedCyclone.monsoonDepressionEndTime) {
        updatedCyclone.isMonsoonDepression = false;
    }

    // steering & movement
    const { steerU, steerV, shearU, shearV } = calculateSteering(updatedCyclone.lon, updatedCyclone.lat, pressureSystems);
    const physicalShear = Math.hypot(shearU, shearV) * 2.0; 
    
    // wind shear application
    let totalShear = physicalShear * (globalShearSetting / 100.0);
    const isWinterHalf = (month >= 11 || month <= 4);
    const shearEventProb = (isWinterHalf && updatedCyclone.lon > 100 && updatedCyclone.lon < 121 && updatedCyclone.lat > 16) 
        ? 0.55 : (isWinterHalf ? 0.045 * (globalShearSetting ** 2 / 10000) : 0.03 * (globalShearSetting ** 2 / 10000));
    
    // random shear events
    if (updatedCyclone.shearEventActive) {
        if (updatedCyclone.age >= updatedCyclone.shearEventEndTime) {
            updatedCyclone.shearEventActive = false;
            updatedCyclone.shearEventMagnitude = 0;
        } else {
            totalShear += Math.max(0, updatedCyclone.shearEventMagnitude);
        }
    } else if (Math.random() < shearEventProb && !updatedCyclone.isTransitioning) {
        updatedCyclone.shearEventActive = true;
        updatedCyclone.shearEventEndTime = updatedCyclone.age + (1 + Math.random() * 48);
        updatedCyclone.shearEventMagnitude = -3 + Math.random() * 6 + 1.8 * Math.abs(month - 8) ** 0.5 + Math.max(0, (globalShearSetting / 10 - 10));
    }

    let steeringDirection = (Math.atan2(steerU, steerV) * RAD_TO_DEG + 360) % 360;
    let angleDiff = steeringDirection - updatedCyclone.direction;
    while (angleDiff < -180) angleDiff += 360;
    while (angleDiff > 180) angleDiff -= 360;
    updatedCyclone.direction = (updatedCyclone.direction + angleDiff * 0.25 + 360) % 360;

    const steeringSpeedKnots = Math.hypot(steerU, steerV) * 1.94384; 
    updatedCyclone.speed += (steeringSpeedKnots - updatedCyclone.speed) * (0.3 + Math.max(0, updatedCyclone.lat / 100));

    // upwelling/cold water mixing
    if (updatedCyclone.speed < 6) {
        const coolingRate = (6 - updatedCyclone.speed) / 6 * 0.25; 
        updatedCyclone.upwellingCoolingEffect = Math.min(updatedCyclone.upwellingCoolingEffect + coolingRate, 5.0); 
    } else {
        updatedCyclone.upwellingCoolingEffect = Math.max(updatedCyclone.upwellingCoolingEffect - 0.2, 0); 
    }

    let sst = getSST(updatedCyclone.lat, updatedCyclone.lon, month, globalTemp) - updatedCyclone.upwellingCoolingEffect;
    
    if (!updatedCyclone.isTransitioning && sst < -8.0) {
        updatedCyclone.isTransitioning = true;
    }
    
    const oldIntensity = updatedCyclone.intensity;
    const terrainElevation = getElevationAt(updatedCyclone.lon, updatedCyclone.lat);
    const landStatus = getLandStatus(updatedCyclone.lon, updatedCyclone.lat, 0.2);
    
    updatedCyclone.isLand = landStatus.isLand;
    const EXf = !updatedCyclone.isExtratropical ? 1 : 0.1;

    // intensity change logic
    if (terrainElevation > 0 && updatedCyclone.intensity > 45) {
        // high terrain decay
        let weakeningFactor = 0.88 + updatedCyclone.circulationSize * 0.0001 * EXf - (terrainElevation / 1200);
        const JPAdj = (updatedCyclone.lat >= 30 && updatedCyclone.lat <= 40 && updatedCyclone.lon >= 129 && updatedCyclone.lon <= 140) ? 0.03 : 0;
        updatedCyclone.intensity *= weakeningFactor + JPAdj;
        updatedCyclone.circulationSize *= 1 + terrainElevation * 0.0008;

    } else if (landStatus.isLand || landStatus.isNearLand) {
        // flat land or near land decay
        const JPAdjustment = (updatedCyclone.lat >= 30 && updatedCyclone.lat <= 40 && updatedCyclone.lon >= 129 && updatedCyclone.lon <= 140) ? 0.04 : 0;
        const PHAdjustment = (updatedCyclone.lat >= 5 && updatedCyclone.lat <= 18 && updatedCyclone.lon >= 120 && updatedCyclone.lon <= 127 && updatedCyclone.intensity < 85) ? 0.05 : 0;
        const AUAdjustment = (updatedCyclone.lat >= -18 && updatedCyclone.lat <= -10 && updatedCyclone.lon >= 123 && updatedCyclone.lon <= 137) ? 0.05 : 0;
        
        updatedCyclone.intensity *= 0.88 + updatedCyclone.circulationSize * 0.0001 * EXf + JPAdjustment + PHAdjustment + AUAdjustment;
        updatedCyclone.speed *= 0.99;

    } else if (updatedCyclone.isExtratropical) {
        // extratropical physics
        updatedCyclone.speed += 1.5; 
        if (updatedCyclone.extratropicalStage === 'developing') {
            if (updatedCyclone.age >= updatedCyclone.extratropicalDevelopmentEndTime) {
                updatedCyclone.extratropicalStage = 'decaying';
                updatedCyclone.intensity += -6 + Math.random() * 6;
            } else {
                const intensification = (updatedCyclone.extratropicalMaxIntensity - updatedCyclone.intensity) / (9 + Math.random() * 5);
                updatedCyclone.intensity += intensification;
            }
        } else { 
            updatedCyclone.intensity += -1 - Math.random() * 2;
        }

    } else {
        // thermodynamic growth (MPI & ERC)
        let mpi = sst > 25.0 ? 264.28 * (1 - Math.exp(-0.182 * (sst - 25.00))) : 0;
        
        // eyewall replacement cycle (ERC)
        switch (updatedCyclone.ercState) {
            case 'weakening':
                if (updatedCyclone.age < updatedCyclone.ercEndTime) {
                    updatedCyclone.ercMpiReduction = Math.random() * 7 * Math.max(0, (updatedCyclone.intensity / 90)); 
                    updatedCyclone.intensity -= updatedCyclone.ercMpiReduction;
                }
                updatedCyclone.circulationSize *= 1.015; 
                if (updatedCyclone.age >= updatedCyclone.ercEndTime) {
                    updatedCyclone.ercState = 'recovering';
                    updatedCyclone.ercEndTime = updatedCyclone.age + (2 + Math.floor(Math.random() * 8)) * 3;
                }
                break;
            case 'recovering':
                updatedCyclone.circulationSize *= 0.995;
                if (updatedCyclone.age >= updatedCyclone.ercEndTime) {
                    updatedCyclone.ercState = 'none';
                    updatedCyclone.ercMpiReduction = 0;
                }
                break;
            default:
                if (updatedCyclone.intensity > 96 && !landStatus.isLand && !updatedCyclone.isTransitioning && Math.random() < 0.12) {
                    updatedCyclone.ercState = 'weakening';
                    updatedCyclone.ercEndTime = updatedCyclone.age + (4 + Math.floor(Math.random() * 10)) * 3;
                }
                break;
        }

        // base intensification rate
        let latF = (0.4 / Math.abs(updatedCyclone.lat) ** 2) * (updatedCyclone.intensity / 50);
        let ri = Math.random() > 0.97 ? Math.random() * 0.35 - 0.05 : 0;
        let intensificationRate = Math.random() * (0.14 + ri) * Math.min(1, ((updatedCyclone.intensity - 13) / 65)) - latF;

        if (updatedCyclone.isMonsoonDepression) {
            intensificationRate *= (Math.random() + 0.10) * 0.70; 
        }
        
        const potentialChange = (mpi - updatedCyclone.intensity) * intensificationRate;
        
        // shear penalty
        let shear = totalShear / 10.0; 
        const nioShearBoost = (updatedCyclone.lat >= 5 && updatedCyclone.lat <= 30 && updatedCyclone.lon >= 30 && updatedCyclone.lon <= 100) ? 8.5 : 0;
        const shemShearBoost = (updatedCyclone.lat <= -5 && updatedCyclone.lat >= -30 && updatedCyclone.lon >= 100) ? (25.0 * Math.sin((month - 2) * (Math.PI / 6))) : 0;
        
        let baseGradient = updatedCyclone.lat > 0 ? (2.0 * Math.cos((month - 2) * (Math.PI / 6))) : (1.5 * Math.sin((month - 2) * (Math.PI / 6)));
        let highLatCorrection = Math.abs(updatedCyclone.lat) > 35 ? Math.pow(Math.abs(updatedCyclone.lat) - 35, 0.9) * -0.1 : 0;
        
        shear += Math.max(0, (Math.abs(updatedCyclone.lat) * (baseGradient + highLatCorrection) - 30 + nioShearBoost + shemShearBoost)) / 20;

        // dry air/humidity penalty
        const samplingRadiusDeg = cyclone.circulationSize * 0.005;
        let envHumiditySum = 0;
        let minEnvHumidity = 60;
        const samplePoints = 12; 
        
        for (let i = 0; i < samplePoints; i++) {
            const angleRad = (i / samplePoints) * 2 * Math.PI;
            const sampleLon = cyclone.lon + samplingRadiusDeg * Math.cos(angleRad) / Math.cos(cyclone.lat * DEG_TO_RAD);
            const sampleLat = cyclone.lat + samplingRadiusDeg * Math.sin(angleRad);
            const val = calculateBackgroundHumidity(sampleLon, sampleLat, pressureSystems, month, cyclone, globalTemp);
            envHumiditySum += val;
            if (val < minEnvHumidity) minEnvHumidity = val;
        }
        
        const effectiveHumidity = (minEnvHumidity * 0.4) + ((envHumiditySum / samplePoints) * 0.6);
        let dryAirFactor = 0;
        if (effectiveHumidity < 60) {
            dryAirFactor = (60 - effectiveHumidity) * 0.0002 * (600 - cyclone.circulationSize);
        }
        
        const clampedSize = Math.max(150, Math.min(500, updatedCyclone.circulationSize || 300));
        const sizeFactor = 1.2 + (clampedSize - 150) * (0.8 - 1.2) / (500 - 150);
        
        updatedCyclone.intensity += (potentialChange - sizeFactor * shear - dryAirFactor);
    }

    // extratypical transition check
    if ((!updatedCyclone.isExtratropical && sst < 25.5 && (Math.abs(updatedCyclone.lat) > frontalZone.latitude) || sst < 23.0) || (updatedCyclone.isSubtropical && sst < 25.5)) {
        updatedCyclone.isExtratropical = true;
        if (updatedCyclone.extratropicalStage === 'none') { 
            if (Math.random() < 0.33 && Math.abs(updatedCyclone.lat) > 25) { 
                updatedCyclone.extratropicalStage = 'developing';
                updatedCyclone.extratropicalDevelopmentEndTime = updatedCyclone.age + ((4 + Math.floor(Math.random() * 25)) * 3);
                updatedCyclone.extratropicalMaxIntensity = 45 + Math.random() * 45;
            } else {
                updatedCyclone.extratropicalStage = 'decaying';
            }
        }
    }

    if (updatedCyclone.isSubtropical && (updatedCyclone.age >= updatedCyclone.subtropicalTransitionTime || updatedCyclone.isExtratropical)) {
        updatedCyclone.isSubtropical = false;
    }

    const intensityChange = updatedCyclone.intensity - oldIntensity;
    if (updatedCyclone.isExtratropical || updatedCyclone.isTransitioning) {
        updatedCyclone.circulationSize *= 1.04;
    } else if (intensityChange > 0.5) {
        updatedCyclone.circulationSize *= 0.99;
    } else {
        updatedCyclone.circulationSize *= 1.002;
    }
    updatedCyclone.circulationSize = Math.max(100, Math.min(updatedCyclone.circulationSize, 800));
    updatedCyclone.intensity = Math.max(10, updatedCyclone.intensity);
    
    // apply displacement
    const currentSpeed = Math.max(2, updatedCyclone.speed);
    const finalStepDirection = updatedCyclone.direction + (Math.random() - 0.5) * 30;
    const angleRad = (90 - finalStepDirection) * DEG_TO_RAD;
    const distanceDeg = currentSpeed * 0.050054; // (3 hours * 1.852 km/h / 111.32)

    const currentEnvPressure = getPressureAt(updatedCyclone.lon, updatedCyclone.lat, pressureSystems);
    const currentCentralPressure = windToPressure(
        updatedCyclone.intensity, 
        updatedCyclone.circulationSize, 
        updatedCyclone.basin, 
        currentEnvPressure
    );

    // wind radii calculation
    const RMW_KM = 5 + updatedCyclone.circulationSize * 0.15; 
    const MAX_SEARCH_KM = 900; 
    const STEP_KM = 15;        
    const SCAN_ANGLE_STEP = 10; 

    const measureRadius = (angleRad, threshold) => {
        const centerLatRad = updatedCyclone.lat * DEG_TO_RAD;
        const lonScale = 1.0 / Math.max(0.1, Math.cos(centerLatRad));
        const cosAngle = Math.cos(angleRad);
        const sinAngle = Math.sin(angleRad);

        let currentDist = RMW_KM;
        while (currentDist < MAX_SEARCH_KM) {
            const distDeg = currentDist * INV_KM_PER_DEG;
            const lon = updatedCyclone.lon + distDeg * cosAngle * lonScale;
            const lat = updatedCyclone.lat + distDeg * sinAngle;
            
            const vec = getWindVectorAt(lon, lat, month, updatedCyclone, pressureSystems);
            if (vec.magnitude < threshold) return currentDist;
            currentDist += STEP_KM;
        }
        return currentDist; 
    };

    const getQuadrantMax = (threshold) => {
        if (updatedCyclone.intensity < threshold) return [0, 0, 0, 0];
        
        const ranges = [ [0, 90], [270, 360], [180, 270], [90, 180] ];
        const result = [];
        
        for (let range of ranges) {
            let maxKm = 0;
            for (let angle = range[0]; angle <= range[1]; angle += SCAN_ANGLE_STEP) {
                const distKm = measureRadius(angle * DEG_TO_RAD, threshold);
                if (distKm > maxKm) maxKm = distKm;
            }
            result.push(maxKm * INV_KM_PER_DEG);
        }
        return result;
    };

    const radii34 = getQuadrantMax(34);
    const radii50 = getQuadrantMax(50);
    const radii64 = getQuadrantMax(64);

    let newLat = updatedCyclone.lat + distanceDeg * Math.sin(angleRad);
    let newLon = updatedCyclone.lon + distanceDeg * Math.cos(angleRad) / Math.cos(updatedCyclone.lat * DEG_TO_RAD);
    
    updatedCyclone.lon = normalizeLongitude(newLon); 
    updatedCyclone.lat = newLat;
    
    updatedCyclone.track.push([
        updatedCyclone.lon, updatedCyclone.lat, updatedCyclone.intensity, 
        updatedCyclone.isTransitioning, updatedCyclone.isExtratropical, 
        updatedCyclone.circulationSize, updatedCyclone.isSubtropical, 
        radii34, radii50, radii64, Math.round(currentCentralPressure)
    ]);

    // dissipation check
    if (updatedCyclone.intensity < 17 || (updatedCyclone.isExtratropical && updatedCyclone.intensity < 24) || Math.abs(updatedCyclone.lat) > 70) {
        updatedCyclone.status = 'dissipated';
    }
    
    // naming logic
    if (!updatedCyclone.named && updatedCyclone.intensity >= 34 && !updatedCyclone.isExtratropical) {
        updatedCyclone.named = true;
        const basinKey = updatedCyclone.basin || 'WPAC';
        const list = NAME_LISTS[basinKey] || NAME_LISTS['WPAC'];
        updatedCyclone.name = list[nameIndex % list.length];
        console.log(`System upgraded to Tropical Storm ${updatedCyclone.name} (${basinKey})`);
    }
    
    return updatedCyclone;
}