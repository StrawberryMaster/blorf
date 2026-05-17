/**
 * js/terrain-data.js
 * Manages terrain elevation data and land masking
 */

let elevationData = null;
let landMaskData = null;
let mapWidth = 0;
let mapHeight = 0;

const inv360 = 1 / 360;
const inv180 = 1 / 180;

const MAX_ELEVATION_METERS = 680;

export function initTerrainSystem(imageUrl, worldData) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = imageUrl;

        img.onload = () => {
            mapWidth = img.width;
            mapHeight = img.height;

            const canvas = document.createElement('canvas');
            canvas.width = mapWidth;
            canvas.height = mapHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            
            // process elevation data
            ctx.drawImage(img, 0, 0);
            const elevRaw = ctx.getImageData(0, 0, mapWidth, mapHeight).data;
            const totalPixels = mapWidth * mapHeight;

            elevationData = new Uint8Array(totalPixels);

            for (let i = 0, j = 0; i < totalPixels; i++, j += 4) {
                elevationData[i] = elevRaw[j];
            }
            
            // generate land mask
            if (worldData) {
                const projection = d3.geoEquirectangular()
                    .scale(mapWidth / (2 * Math.PI))
                    .translate([mapWidth / 2, mapHeight / 2]);

                const pathGenerator = d3.geoPath()
                    .projection(projection)
                    .context(ctx);

                // draw ocean (black)
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, mapWidth, mapHeight);

                // draw land (white)
                ctx.fillStyle = '#FFFFFF';
                ctx.beginPath();
                pathGenerator(worldData);
                ctx.fill();

                const maskRaw = ctx.getImageData(0, 0, mapWidth, mapHeight).data;
                landMaskData = new Uint8Array(totalPixels);

                for (let i = 0, j = 0; i < totalPixels; i++, j += 4) {
                    landMaskData[i] = maskRaw[j];
                }
            }

            console.log(`Terrain system initialized. Size: ${mapWidth}x${mapHeight}`);
            resolve();
        };

        img.onerror = () => reject(new Error("Failed to load elevation map"));
    });
}

// inlineable pixel coordinate calculator
function getPixelCoords(lon, lat) {
    // normalize longitude to [-180, 180]
    const normLon = ((lon + 180) % 360 + 360) % 360 - 180;

    // bitwise truncation
    let x = ~~(((normLon + 180) * inv360) * mapWidth);
    let y = ~~(((90 - lat) * inv180) * mapHeight);

    // boundary clamp
    if (x < 0) x = 0; else if (x >= mapWidth) x = mapWidth - 1;
    if (y < 0) y = 0; else if (y >= mapHeight) y = mapHeight - 1;

    return { x, y };
}

const STATUS_WATER = { isLand: false, isNearLand: false };
const STATUS_NEAR  = { isLand: false, isNearLand: true };
const STATUS_LAND  = { isLand: true, isNearLand: true };

export function getElevationAt(lon, lat) {
    if (!elevationData) return 0;

    let normLon = lon % 360;
    if (normLon < -180) normLon += 360;
    else if (normLon > 180) normLon -= 360;

    let x = ~~(((normLon + 180) * inv360) * mapWidth);
    let y = ~~(((90 - lat) * inv180) * mapHeight);

    if (x < 0) x = 0; else if (x >= mapWidth) x = mapWidth - 1;
    if (y < 0) y = 0; else if (y >= mapHeight) y = mapHeight - 1;

    const brightness = elevationData[y * mapWidth + x];

    // skip tiny values to reduce math overhead for flat oceans
    if (brightness < 5) return 0;
    return (brightness / 255) * MAX_ELEVATION_METERS;
}

export function getLandStatus(lon, lat, nearThresholdDeg = 0.2) {
    if (!landMaskData) return STATUS_WATER;

    // coordinate mapping
    let normLon = lon % 360;
    if (normLon < -180) normLon += 360;
    else if (normLon > 180) normLon -= 360;

    let cx = ~~(((normLon + 180) * inv360) * mapWidth);
    let cy = ~~(((90 - lat) * inv180) * mapHeight);

    if (cx < 0) cx = 0; else if (cx >= mapWidth) cx = mapWidth - 1;
    if (cy < 0) cy = 0; else if (cy >= mapHeight) cy = mapHeight - 1;

    const centerIdx = cy * mapWidth + cx;

    // fast exit if directly on land
    if (landMaskData[centerIdx] > 128) return STATUS_LAND;

    const radius = Math.max(1, Math.ceil(nearThresholdDeg * mapWidth * inv360));
    const startY = Math.max(0, cy - radius);
    const endY = Math.min(mapHeight - 1, cy + radius);

    // scan neighborhood
    for (let y = startY; y <= endY; y++) {
        const rowOffset = y * mapWidth;

        for (let dx = -radius; dx <= radius; dx++) {
            let nx = cx + dx;
            
            // horizontal map wrapping
            if (nx < 0) nx += mapWidth;
            else if (nx >= mapWidth) nx -= mapWidth;

            // 1D index check
            if (landMaskData[rowOffset + nx] > 128) {
                return STATUS_NEAR;
            }
        }
    }

    return STATUS_WATER;
}
