/**
 * js/utils.js
 * Contains shared, stateless utility functions and math helpers
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export const NAME_LISTS = {
    'WPAC': [
        'Damrey', 'Haikui', 'Kirogi', 'Yun-yeung', 'Koinu', 'Bolaven', 'Sanba', 'Jelawat', 'Ewiniar', 'Maliksi', 'Gaemi', 'Prapiroon', 'Maria', 'Son-Tinh',
        'Ampil', 'Wukong', 'Jongdari', 'Shanshan', 'Yagi', 'Leepi', 'Bebinca', 'Pulasan', 'Soulik', 'Cimaron', 'Jebi', 'Krathon', 'Barijat', 'Trami',
        'Kong-rey', 'Yinxing', 'Toraji', 'Man-yi', 'Usagi', 'Pabuk', 'Wutip', 'Sepat', 'Mun', 'Danas', 'Nari', 'Wipha', 'Francisco', 'Co-May',
        'Krosa', 'Bailu', 'Podul', 'Lingling', 'Kajiki', 'Nongfa', 'Peipah', 'Tapah', 'Mitag', 'Ragasa', 'Neoguri', 'Bualoi', 'Matmo', 'Halong',
        'Nakri', 'Fengshen', 'Kalmaegi', 'Fung-wong', 'Koto', 'Nokaen', 'Penha', 'Nuri', 'Sinlaku', 'Hagupit', 'Jangmi', 'Mekkhala', 'Higos', 'Bavi',
        'Maysak', 'Haishen', 'Noul', 'Dolphin', 'Kujira', 'Chan-hom', 'Peilou', 'Nangka', 'Saudel', 'Narra', 'Gaenari', 'Atsani', 'Etau', 'Bang-Lang',
        'Krovanh', 'Dujuan', 'Surigae', 'Choi-wan', 'Koguma', 'Champi', 'In-fa', 'Cempaka', 'Nepartak', 'Lupit', 'Mirinae', 'Nida', 'Omais', 'Luc-Binh',
        'Chanthu', 'Dianmu', 'Mindulle', 'Lionrock', 'Tokei', 'Namtheun', 'Malou', 'Nyatoh', 'Sarbul', 'Amuyao', 'Gosari', 'Chaba', 'Aere', 'Songda',
        'Trases', 'Mulan', 'Meari', 'Tsing-ma', 'Tokage', 'Ong-mang', 'Muifa', 'Merbok', 'Nanmadol', 'Talas', 'Hodu', 'Kulap', 'Roke', 'Sonca',
        'Nesat', 'Haitang', 'Jamjari', 'Banyan', 'Yamaneko', 'Pakhar', 'Sanvu', 'Mawar', 'Guchol', 'Talim', 'Bori', 'Khanun', 'Lan', 'Saobien'
    ],
    'NATL': [
        'Alberto', 'Beryl', 'Chris', 'Debby', 'Ernesto', 'Francine', 'Gordon', 'Helene', 'Isaac', 'Joyce', 'Kirk', 'Leslie', 'Milton', 'Nadine', 'Oscar', 'Patty', 'Rafael', 'Sara', 'Tony', 'Valerie', 'William',
        'Andrea', 'Barry', 'Chantal', 'Dexter', 'Erin', 'Fernand', 'Gabrielle', 'Humberto', 'Imelda', 'Jerry', 'Karen', 'Lorenzo', 'Melissa', 'Nestor', 'Olga', 'Pablo', 'Rebekah', 'Sebastien', 'Tanya', 'Van', 'Wendy',
        'Arthur', 'Bertha', 'Cristobal', 'Dolly', 'Edouard', 'Fay', 'Gonzalo', 'Hanna', 'Isaias', 'Josephine', 'Kyle', 'Leah', 'Marco', 'Nana', 'Omar', 'Paulette', 'Rene', 'Sally', 'Teddy', 'Vicky', 'Wilfred',
        'Ana', 'Bill', 'Claudette', 'Danny', 'Elsa', 'Fred', 'Grace', 'Henri', 'Idalia', 'Julian', 'Kate', 'Larry', 'Mindy', 'Nicholas', 'Odette', 'Peter', 'Rose', 'Sam', 'Teresa', 'Victor', 'Wanda',
        'Alex', 'Bonnie', 'Colin', 'Danielle', 'Earl', 'Farrah', 'Gaston', 'Hermine', 'Idris', 'Julia', 'Karl', 'Lisa', 'Martin', 'Nicole', 'Owen', 'Paula', 'Richard', 'Shary', 'Tobias', 'Virginie', 'Walter',
        'Arlene', 'Bret', 'Cindy', 'Don', 'Emily', 'Franklin', 'Gert', 'Harold', 'Idalia', 'Jose', 'Katia', 'Lee', 'Margot', 'Nigel', 'Ophelia', 'Philippe', 'Rina', 'Sean', 'Tammy', 'Vince', 'Whitney'
    ],
    'EPAC': [
        'Aletta', 'Bud', 'Carlotta', 'Daniel', 'Emilia', 'Fabio', 'Gilma', 'Hector', 'Ileana', 'John', 'Kristy', 'Lane', 'Miriam', 'Norman', 'Olivia', 'Paul', 'Rosa', 'Sergio', 'Tara', 'Vicente', 'Willa', 'Xavier', 'Yolanda', 'Zeke',
        'Alvin', 'Barbara', 'Cosme', 'Dalila', 'Erick', 'Flossie', 'Gil', 'Henriette', 'Ivo', 'Juliette', 'Kiko', 'Lorena', 'Mario', 'Narda', 'Octave', 'Priscilla', 'Raymond', 'Sonia', 'Tico', 'Velma', 'Wallis', 'Xina', 'York', 'Zelda'
    ],
    'NIO': [
        'Nisarga', 'Gati', 'Nivar', 'Burevi', 'Tauktae', 'Yaas', 'Gulab', 'Shaheen', 'Jawad', 'Asani', 'Sitrang', 'Mandous', 'Mocha',
        'Biparjoy', 'Tej', 'Hamoon', 'Michaung', 'Remal', 'Asna', 'Dana', 'Fengal', 'Shakthi', 'Montha', 'Senyar', 'Ditwah', 'Afoor',
        'Arnab', 'Muran', 'Uru', 'Ana', 'Baan', 'Phet', 'Gaur', 'Rahgu', 'Chhas', 'Ajar', 'Probaho', 'Jurzum', 'Bhumra',
        'Upakul', 'Aag', 'Vyom', 'Bojon', 'Jinkul', 'Pha', 'Shobha', 'Umban', 'Udita', 'Maha', 'Odi', 'Kenda', 'Ghenim',
        'Barshon', 'Neer', 'Gagan', 'Zum', 'Lisu', 'Yan', 'Prabhanjan', 'Titli', 'Teer', 'Ghuman', 'Ghambhira', 'Naseem', 'Pheru',
        'Nishit', 'Prabho', 'Jhar', 'Upana', 'Ambud', 'Singha', 'Ghurni', 'Viyana', 'Baru', 'Ghasha', 'Kurum', 'Saffar', 'Karo'
    ],
    'SIO': [
        'Alvaro', 'Belal', 'Candice', 'Djoungou', 'Eleanor', 'Filipo', 'Gamane', 'Hidaya', 'Ialy', 'Jeremy', 'Kanga', 'Ludzi', 'Melina', 'Nathan', 'Onias', 'Pelagie', 'Quamar', 'Rita', 'Solani', 'Tarik', 'Urilia', 'Vuyane', 'Wagner', 'Xusa', 'Yarona', 'Zacarias',
        'Ancha', 'Bheki', 'Chido', 'Dikeledi', 'Elvis', 'Faida', 'Garance', 'Hondwa', 'Ivone', 'Jude', 'Kanto', 'Lira', 'Maipelo', 'Njazi', 'Oscar', 'Pamela', 'Quentin', 'Rajab', 'Savana', 'Themba', 'Uyapo', 'Viviane', 'Walter', 'Xangy', 'Yemurai', 'Zanele',
        'Awa', 'Boura', 'Cerane', 'Diem', 'Eyram', 'Fani', 'Gumball', 'Helako', 'Izalia', 'Joalane', 'Kacha', 'Luka', 'Maia', 'Naima', 'Osman', 'Panda', 'Quenelle', 'Rashaka', 'Sweety', 'Tiana', 'Uzo', 'Valini', 'Wilson', 'Xila', 'Yezda', 'Zidane'
    ],
    'SHEM': [
        'Anika', 'Billy', 'Charlotte', 'Darian', 'Ellie', 'Freddy', 'Gabrielle', 'Herman', 'Ilsa', 'Jasper', 'Kirrily', 'Lincoln', 'Megan', 'Neville', 'Olga', 'Paul', 'Robyn', 'Sean', 'Tiffany', 'Urton', 'Vicki',
        'Alessia', 'Bruce', 'Catherine', 'Dylan', 'Edna', 'Fletcher', 'Gillian', 'Hadi', 'Ivana', 'Jack', 'Kate', 'Laszlo', 'Mingzhu', 'Nathan', 'Oriana', 'Quincey', 'Raquel', 'Stan', 'Tatiana', 'Uriah', 'Yvette',
        'Alfred', 'Blanche', 'Caleb', 'Dara', 'Ernie', 'Frances', 'Greg', 'Hilda', 'Irving', 'Joyce', 'Kelvin', 'Linda', 'Marco', 'Nora', 'Owen', 'Penny', 'Riley', 'Savannah', 'Trevor', 'Veronica', 'Wallace',
        'Ana', 'Bina', 'Cody', 'Dovi', 'Eva', 'Fili', 'Gina', 'Hale', 'Irene', 'Judy', 'Kevin', 'Lola', 'Mal', 'Nat', 'Osi', 'Peta', 'Rae', 'Sheila', 'Tam', 'Urmil', 'Vaianu', 'Wati', 'Xavier', 'Yani', 'Zita'
    ],
    'SATL': [
        'Arani', 'Bapu', 'Cari', 'Deni', 'Ecaí', 'Guará', 'Iba', 'Jaguar', 'Kurumí', 'Mani', 'Oquira', 'Potira', 'Raoni', 'Ubá', 'Yakecan',
        'Akará', 'Biguá', 'Caue', 'Domó', 'Endy', 'Guarani', 'Iguaçú', 'Jaci', 'Kaeté', 'Maracá', 'Okara', 'Poti', 'Reri', 'Sumé', 'Tupã',
        'Upaba', 'Votu', 'Ybba', 'Zeus'
    ]
};

const NOISE_CONFIG = {
    seed: 12345.67,
    baseScale: 25,
    detailScale: 8,
    baseAmp: 1.5,
    detailAmp: 0.5
};

const INV_BASE_SCALE = 1 / NOISE_CONFIG.baseScale;
const INV_DETAIL_SCALE = 1 / NOISE_CONFIG.detailScale;
const PRESSURE_COEFF = 12.5 / 512.63;

function pseudoNoise(x, y, seed) {
    const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
    return n - Math.floor(n);
}

function getSmoothNoise(lon, lat, invScale, seed) {
    const x = lon * invScale;
    const y = lat * invScale;

    const i = Math.floor(x);
    const j = Math.floor(y);

    const fX = x - i;
    const fY = y - j;

    // ease curve: 3t^2 - 2t^3
    const u = fX * fX * (3.0 - 2.0 * fX);
    const v = fY * fY * (3.0 - 2.0 * fY);

    const n00 = pseudoNoise(i, j, seed);
    const n10 = pseudoNoise(i + 1, j, seed);
    const n01 = pseudoNoise(i, j + 1, seed);
    const n11 = pseudoNoise(i + 1, j + 1, seed);

    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;

    return nx0 * (1 - v) + nx1 * v;
}

export function calculateAtmosphericNoise(lon, lat) {
    const base = (getSmoothNoise(lon, lat, INV_BASE_SCALE, NOISE_CONFIG.seed) - 0.5) * 2;
    const detail = (getSmoothNoise(lon, lat, INV_DETAIL_SCALE, NOISE_CONFIG.seed + 100) - 0.5) * 8;
    return (base * NOISE_CONFIG.baseAmp) + (detail * NOISE_CONFIG.detailAmp);
}

export const normalizeLongitude = (lon) => {
    let result = (lon + 180) % 360;
    if (result < 0) result += 360;
    return result - 180;
};

export const shortestLongitudeDistance = (lon1, lon2) => {
    let diff = lon1 - lon2;
    if (diff > 180) diff -= 360;
    else if (diff < -180) diff += 360;
    return diff;
};

export function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const lat1Rad = lat1 * DEG_TO_RAD;
    const lat2Rad = lat2 * DEG_TO_RAD;

    const sinHalfLat = Math.sin(dLat * 0.5);
    const sinHalfLon = Math.sin(dLon * 0.5);

    const a = sinHalfLat * sinHalfLat + Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinHalfLon * sinHalfLon;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

export const unwrapLongitude = (lon, referenceLon) => {
    if (isNaN(referenceLon)) return lon;
    const diff = lon - referenceLon;
    if (Math.abs(diff) > 180) {
        lon += (diff > 0) ? -360 : 360;
    }
    return lon;
};

export function calculateHollandPressure(r, Rm, Pc, Pn) {
    if (r <= 5) return Pc;
    return Pc + (Pn - Pc) * Math.exp(-Rm / r);
}

export function createGeoCircle(centerLon, centerLat, radiusKm, numPoints = 64) {
    const coords = [];
    const radiusRad = radiusKm / 6371;
    const lat1 = centerLat * DEG_TO_RAD;
    const lon1 = centerLon * DEG_TO_RAD;

    const cosLat1 = Math.cos(lat1);
    const sinLat1 = Math.sin(lat1);
    const cosRadiusRad = Math.cos(radiusRad);
    const sinRadiusRad = Math.sin(radiusRad);

    for (let i = 0; i <= numPoints; i++) {
        const bearing = (i / numPoints) * 2 * Math.PI;
        const cosBearing = Math.cos(bearing);
        const sinBearing = Math.sin(bearing);

        const lat2 = Math.asin(sinLat1 * cosRadiusRad + cosLat1 * sinRadiusRad * cosBearing);
        const lon2 = lon1 + Math.atan2(sinBearing * sinRadiusRad * cosLat1, cosRadiusRad - sinLat1 * Math.sin(lat2));

        coords.push([lon2 * RAD_TO_DEG, lat2 * RAD_TO_DEG]);
    }
    return { type: "LineString", coordinates: coords };
}

export const getCategory = (windKts, isTransitioning = false, isExtratropical = false, isSubtropical = false) => {
    if (isSubtropical) {
        if (windKts < 34) return { name: "Subtropical depression", shortName: "SD", color: "#76d7c4" };
        return { name: "Subtropical storm", shortName: "SS", color: "#48c9b0" };
    }
    if (isExtratropical) return { name: "Extratropical cyclone", shortName: "EXT", color: "#8e44ad" };
    if (isTransitioning) return { name: "Extratropical transition", shortName: "ET", color: "#efcdeb" };
    if (windKts < 24) return { name: "Low pressure area", shortName: "LPA", color: "#aaaaaa" };
    if (windKts < 34) return { name: "Tropical depression", shortName: "TD", color: "#6ec1ea" };
    if (windKts < 64) return { name: "Tropical storm", shortName: "TS", color: "#4dffff" };
    if (windKts < 83) return { name: "Category 1", shortName: "Cat 1", color: "#ffffd9" };
    if (windKts < 96) return { name: "Category 2", shortName: "Cat 2", color: "#ffd98c" };
    if (windKts < 113) return { name: "Category 3", shortName: "Cat 3", color: "#ff9e59" };
    if (windKts < 137) return { name: "Category 4", shortName: "Cat 4", color: "#ff738a" };
    return { name: "Category 5", shortName: "Cat 5", color: "#8d75e6" };
};

export const knotsToKph = kts => Math.round(kts * 1.852);
export const knotsToMph = kts => Math.round(kts * 1.15078);

export const windToPressure = (windKts, circulationSize = 300, basin = 'WPAC', envPressure = null) => {
    let backgroundPressure = envPressure;
    if (backgroundPressure == null) {
        backgroundPressure = (basin === 'WPAC' || basin === 'NIO') ? 1010 : 1018;
    }
    const basePressureCalc = backgroundPressure - Math.pow(windKts, 1.6) * PRESSURE_COEFF;
    const pressure = basePressureCalc + (basePressureCalc - backgroundPressure) * (0.0012 * circulationSize);
    return Math.max(640, Math.round(pressure));
};

export function getPressureAt(lon, lat, pressureSystemsLayer, useNoise = true) {
    let pressureValue = 1010;
    const systems = Array.isArray(pressureSystemsLayer) ? pressureSystemsLayer : (pressureSystemsLayer.lower || []);

    systems.forEach(cell => {
        const dx = shortestLongitudeDistance(lon, cell.x);
        const dy = lat - cell.y;

        // memoize inverse values on objects dynamically to bypass heavy divisions
        let inv2SigmaXSq = cell.inv2SigmaXSq;
        let inv2SigmaYSq = cell.inv2SigmaYSq;
        if (inv2SigmaXSq === undefined || cell._lastSigmaX !== cell.sigmaX) {
            cell._lastSigmaX = cell.sigmaX;
            cell.inv2SigmaXSq = 1 / (2 * cell.sigmaX * cell.sigmaX);
            inv2SigmaXSq = cell.inv2SigmaXSq;
        }
        if (inv2SigmaYSq === undefined || cell._lastSigmaY !== cell.sigmaY) {
            cell._lastSigmaY = cell.sigmaY;
            cell.inv2SigmaYSq = 1 / (2 * cell.sigmaY * cell.sigmaY);
            inv2SigmaYSq = cell.inv2SigmaYSq;
        }

        const exponent = -( (dx * dx) * inv2SigmaXSq + (dy * dy) * inv2SigmaYSq );
        const pressureOffset = Math.exp(exponent) * cell.strength;

        if (cell.noiseLayers) {
            let noise = 0;
            cell.noiseLayers.forEach(layer => {
                noise += Math.sin((lon + layer.offsetX) / layer.freqX) * Math.cos((lat + layer.offsetY) / layer.freqY) * layer.amplitude;
            });
            pressureValue += noise;
        }

        pressureValue += pressureOffset;
    });

    if (useNoise) {
        pressureValue += calculateAtmosphericNoise(lon, lat);
    }

    return pressureValue;
}

export const directionToCompass = deg => {
    const val = Math.floor((deg / 22.5) + 0.5);
    const arr = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return arr[(val % 16)];
};

// map current structures
const OCEAN_CURRENTS = [
    { name: "Cali", lat: 30, lon: -125, max: -3.0, sLat: 15, sLon: 50 },
    { name: "Gulf", lat: 38, lon: -60,  max: 5.0,  sLat: 20, sLon: 30 },
    { name: "SCS",  lat: 20, lon: 115,  max: -1.0, sLat: 20, sLon: 8, seasonal: true },
    { name: "Canary", lat: 30, lon: -20, max: -4.5, sLat: 30, sLon: 45 },
    { name: "Japan", lat: 27, lon: 140, max: 1.0,  sLat: 5,  sLon: 20 },
    { name: "GOM",   lat: 25, lon: -90, max: 3.0,  sLat: 7,  sLon: 10 },
    { name: "Somalia", lat: 10, lon: 50, max: -4.5, sLat: 10, sLon: 15 },
    { name: "Benguela", lat: -25, lon: 5, max: -5.0, sLat: 15, sLon: 20 },
    { name: "WestAus", lat: -35, lon: 105, max: -2.0, sLat: 15, sLon: 20 },
    { name: "Peru", lat: -15, lon: -80, max: -6.0, sLat: 15, sLon: 20 },
    { name: "Seq", lat: -10, lon: 100, max: 2.0, sLat: 5, sLon: 40 }
].map(c => ({
    ...c,
    inv2SigmaLatSq: 1 / (2 * c.sLat * c.sLat),
    inv2SigmaLonSq: 1 / (2 * c.sLon * c.sLon)
}));

export function getSST(lat, lon, month, globalTempK = 289) {
    const BASELINE_TEMP_K = 289.0;
    const tempAnomaly = globalTempK - BASELINE_TEMP_K;

    const absLat = Math.abs(lat);
    const monthDiff = Math.abs(month - 8);

    const monthAngle = (month - 8) * (Math.PI / 6);
    const cosMonth = Math.cos(monthAngle);

    const seasonalModifier = lat > 0
        ? 2.8 + cosMonth * 1.7
        : 2.0 - cosMonth * 1.3;

    let baseSST = absLat < 12
        ? (31.9 + 0.6 * tempAnomaly)
        : Math.max(10, (31.9 + 0.6 * tempAnomaly) - (absLat - 12) / seasonalModifier + Math.pow(absLat / 60, 1.6));

    let currentAdjustment = 0;

    for (let i = 0; i < OCEAN_CURRENTS.length; i++) {
        const curr = OCEAN_CURRENTS[i];
        const dLon = shortestLongitudeDistance(lon, curr.lon);
        const dLat = lat - curr.lat;

        let maxEffect = curr.max;
        let invLonVar = curr.inv2SigmaLonSq;

        // dynamic adjustment for the South China Sea
        if (curr.seasonal) {
            maxEffect = -0.8 - 0.5 * monthDiff;
            const dynSLon = 8 + monthDiff;
            invLonVar = 1 / (2 * dynSLon * dynSLon);
        }

        const influence = Math.exp(-( (dLon * dLon) * invLonVar + (dLat * dLat) * curr.inv2SigmaLatSq ));
        currentAdjustment += maxEffect * influence;
    }

    baseSST += currentAdjustment;
    return Math.max(0, Math.min(60, baseSST));
}
