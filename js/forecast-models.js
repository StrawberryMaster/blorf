/**
 * js/forecast-models.js
 * Generates numerical model forecast tracks and intensities
 */
import { getSST, normalizeLongitude } from './utils.js';
import { calculateSteering, updatePressureSystems } from './cyclone-model.js';
import { calculateBackgroundHumidity } from './visualization.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const DISTANCE_FACTOR_3HR = 0.049911; // 3 hours * 1.852 km/h / 111.32 km/deg

function clonePressureSystems(sys) {
    return {
        upper: sys.upper ? sys.upper.map(s => ({ ...s })) : [],
        lower: sys.lower ? sys.lower.map(s => ({ ...s })) : []
    };
}

export function generatePathForecasts(cyclone, pressureSystems, checkLandFunc = null, globalTemp = 289, globalShearSetting = 100) {
    // abort forecasting for fully extratropical systems
    if (cyclone.isExtratropical) {
        return [];
    }

    const forecasts = [];

    // model definitions
    const models = [
        { name: "ENAI", bias: { u: 0.5, v: 0.6 } }
    ];

    // forecast configuration parameters
    const PATH_STEP_HOURS = 3;
    const INTENSITY_STEP_HOURS = 6;
    const TOTAL_HOURS = 72;

    const STEPS_PER_INTENSITY_UPDATE = INTENSITY_STEP_HOURS / PATH_STEP_HOURS;
    const TOTAL_STEPS = TOTAL_HOURS / PATH_STEP_HOURS;

    models.forEach(model => {
        let tempCyclone = { ...cyclone };
        let tempPressureSystems = clonePressureSystems(pressureSystems);

        let track = [[
            tempCyclone.lon,
            tempCyclone.lat,
            tempCyclone.intensity,
            tempCyclone.isTransitioning,
            tempCyclone.isExtratropical
        ]];

        let lastCalculatedIntensity = tempCyclone.intensity;
        const startAge = tempCyclone.age || 0;

        for (let t = 1; t <= TOTAL_STEPS; t++) {
            // path calculation (every 3 hours)
            updatePressureSystems(tempPressureSystems, cyclone.currentMonth);
            const { steerU, steerV, shearU, shearV } = calculateSteering(tempCyclone.lon, tempCyclone.lat, tempPressureSystems, model.bias);

            let steeringDirection = (Math.atan2(steerU, steerV) * RAD_TO_DEG + 360) % 360;
            let angleDiff = steeringDirection - tempCyclone.direction;
            while (angleDiff < -180) angleDiff += 360;
            while (angleDiff > 180) angleDiff -= 360;

            tempCyclone.direction = (tempCyclone.direction + angleDiff * 0.25 + 360) % 360;

            const steeringSpeedKnots = Math.hypot(steerU, steerV) * 1.94384;
            tempCyclone.speed += (steeringSpeedKnots - tempCyclone.speed) * 0.3;

            const currentSpeed = Math.max(3, tempCyclone.speed);
            const angleRad = (90 - tempCyclone.direction) * DEG_TO_RAD;
            const distanceDeg = currentSpeed * DISTANCE_FACTOR_3HR;

            tempCyclone.lat += distanceDeg * Math.sin(angleRad);

            // adjust longitude spacing based on latitude convergence
            const latScale = Math.cos(tempCyclone.lat * DEG_TO_RAD);
            tempCyclone.lon = normalizeLongitude(tempCyclone.lon + (distanceDeg * Math.cos(angleRad)) / latScale);

            // intensity calculation (every 6 hours)
            if (t % STEPS_PER_INTENSITY_UPDATE === 0) {
                // determine if the *future projected point* is over land
                const isForecastingLand = checkLandFunc && checkLandFunc(tempCyclone.lon, tempCyclone.lat);

                let sst = 29.0;
                let hum = 65.0;
                let nextIntensity = lastCalculatedIntensity;

                if (isForecastingLand) {
                    // land interaction logic
                    const frictionDecay = Math.max(5, lastCalculatedIntensity * 0.22);
                    const naturalDecayResult = lastCalculatedIntensity - frictionDecay;

                    // cannot drop more than 10KT per cycle
                    const hardCap = lastCalculatedIntensity - 10;
                    nextIntensity = Math.min(naturalDecayResult, hardCap);
                } else {
                    // oceanic logic
                    const val = getSST(tempCyclone.lat, tempCyclone.lon, cyclone.currentMonth || 8, globalTemp);
                    if (val != null && val > -5) sst = val;

                    // humidity calculation
                    if (typeof calculateBackgroundHumidity === 'function') {
                        try {
                            const hVal = calculateBackgroundHumidity(tempCyclone.lon, tempCyclone.lat, tempPressureSystems, cyclone.currentMonth, cyclone, globalTemp);
                            if (Number.isFinite(hVal)) hum = hVal;
                        } catch (e) {
                            // fallback to default humidity
                        }
                    }

                    // Maximum Potential Intensity (MPI)
                    let mpi = 0;
                    if (sst >= 24.7) {
                        mpi = (15 + (sst - 24.7) * 24.7 - (75 - hum)) * (1.08 - 1 / tempCyclone.lat);
                    }

                    const safeShearU = Number.isFinite(shearU) ? shearU : 0;
                    const safeShearV = Number.isFinite(shearV) ? shearV : 0;
                    const physicalShear = Math.hypot(safeShearU, safeShearV) * 2.5;
                    const totalShear = physicalShear * (globalShearSetting / 100.0);

                    const gap = mpi - lastCalculatedIntensity;
                    const changeRate = gap > 0
                        ? (Math.random() * 0.04 + 0.07 - 0.9 / lastCalculatedIntensity - (totalShear * 0.005))
                        : (0.11 + (totalShear * 0.003));

                    nextIntensity += gap * changeRate;

                    // apply random shear event penalties if active during this timeframe
                    const currentForecastAge = startAge + (t * PATH_STEP_HOURS);
                    if (tempCyclone.shearEventActive && currentForecastAge < tempCyclone.shearEventEndTime) {
                        const shearPenalty = tempCyclone.shearEventMagnitude * (Math.random() + 0.5);
                        nextIntensity -= shearPenalty;
                    }
                }

                // minimum intensity floor
                nextIntensity = Math.max(15, nextIntensity);

                tempCyclone.intensity = nextIntensity;
                lastCalculatedIntensity = nextIntensity;
            }

            // record step state
            track.push([
                tempCyclone.lon,
                tempCyclone.lat,
                tempCyclone.intensity,
                tempCyclone.isTransitioning || false,
                tempCyclone.isExtratropical || false
            ]);
        }

        forecasts.push({ name: model.name, track });
    });

    return forecasts;
}
