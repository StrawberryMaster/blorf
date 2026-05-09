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
            
            // extract only the red channel (stride of 4)
            for (let i = 0; i < totalPixels; i++) {
                elevationData[i] = elevRaw[i * 4];
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
                
                for (let i = 0; i < totalPixels; i++) {
                    landMaskData[i] = maskRaw[i * 4];
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

export function getElevationAt(lon, lat) {
    if (!elevationData) return 0;
    
    const { x, y } = getPixelCoords(lon, lat);
    const brightness = elevationData[y * mapWidth + x]; 
    
    // skip tiny values to reduce math overhead for flat oceans
    if (brightness < 5) return 0;
    return (brightness / 255) * MAX_ELEVATION_METERS;
}

export function getLandStatus(lon, lat, nearThresholdDeg = 0.2) {
    if (!landMaskData) return { isLand: false, isNearLand: false };

    const { x: cx, y: cy } = getPixelCoords(lon, lat);
    const centerIdx = cy * mapWidth + cx;
    
    // threshold check ( > 128 means white/land)
    const isLand = landMaskData[centerIdx] > 128;
    
    // fast exit if already directly on land
    if (isLand) return { isLand: true, isNearLand: true };

    // determine search radius in pixels
    const radius = Math.max(1, Math.ceil(nearThresholdDeg * mapWidth * inv360));

    // pre-calculate vertical bounds
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
                return { isLand: false, isNearLand: true };
            }
        }
    }

    return { isLand: false, isNearLand: false };
}