// scripts/fetch-forecasts.js
// Runs every 3 hours via GitHub Actions.
// Writes one JSON file per spot into public/data/forecasts/

const fs = require('fs');
const path = require('path');

const spots = require('../spots.json');
const OUTPUT_DIR = path.join(__dirname, '../public/data/forecasts');

// ─── API Fetchers ──────────────────────────────────────────────────────────

async function fetchWaves(lat, lon) {
  const url = new URL('https://marine-api.open-meteo.com/v1/marine');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', [
    'wave_height',
    'wave_period',
    'wave_direction',
    'swell_wave_height',
    'swell_wave_period',
    'swell_wave_direction'
  ].join(','));
  url.searchParams.set('timezone', 'America/New_York');
  url.searchParams.set('forecast_days', '7');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wave API error: ${res.status}`);
  return res.json();
}

async function fetchWind(lat, lon) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lon);
  url.searchParams.set('hourly', [
    'windspeed_10m',
    'winddirection_10m',
    'windgusts_10m'
  ].join(','));
  url.searchParams.set('wind_speed_unit', 'mph');
  url.searchParams.set('timezone', 'America/New_York');
  url.searchParams.set('forecast_days', '7');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wind API error: ${res.status}`);
  return res.json();
}

async function fetchTides(stationId) {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const fmt = (d) =>
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');

  const url = new URL('https://api.tidesandcurrents.noaa.gov/api/prod/datagetter');
  url.searchParams.set('begin_date', fmt(now));
  url.searchParams.set('end_date', fmt(end));
  url.searchParams.set('station', stationId);
  url.searchParams.set('product', 'predictions');
  url.searchParams.set('datum', 'MLLW');
  url.searchParams.set('time_zone', 'lst_ldt');
  url.searchParams.set('interval', 'hilo');
  url.searchParams.set('units', 'english');
  url.searchParams.set('application', 'surf_forecast');
  url.searchParams.set('format', 'json');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Tide API error: ${res.status}`);
  const data = await res.json();

  if (data.error) {
    console.warn(`  ⚠ Tide warning for ${stationId}: ${data.error.message}`);
    return [];
  }
  return data.predictions || [];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function mToFt(m) {
  if (m == null) return null;
  return Math.round(m * 3.28084 * 10) / 10;
}

function compassLabel(deg) {
  if (deg == null) return null;
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Returns a rating object based on wave height, wind, and beach facing direction
function rateConditions(waveHeightFt, windSpeedMph, windDirDeg, beachFacingDeg) {
  if (waveHeightFt == null || windSpeedMph == null) {
    return { score: 0, label: 'No Data', color: '#888' };
  }

  let score = 5;

  // Wave height (feet)
  if (waveHeightFt < 1)       score -= 3;
  else if (waveHeightFt < 2)  score -= 1;
  else if (waveHeightFt <= 4) score += 2;
  else if (waveHeightFt <= 6) score += 1;
  else if (waveHeightFt <= 8) score -= 1;
  else                         score -= 2;

  // Wind direction relative to beach
  // Offshore wind = wind coming FROM land, blowing TO sea
  // If beach faces east (90°), offshore wind comes from west (270°)
  const offshoreSourceDir = (beachFacingDeg + 180) % 360;
  const diff = Math.abs(((windDirDeg - offshoreSourceDir) + 180) % 360 - 180);

  if (diff < 45)       score += 2;  // offshore — best
  else if (diff < 90)  score += 1;  // cross-offshore — good
  else if (diff < 135) score -= 1;  // cross-onshore — ok
  else                 score -= 2;  // onshore — worst

  // Wind speed
  if (windSpeedMph < 5)       score += 1;
  else if (windSpeedMph < 15) score += 0;
  else if (windSpeedMph < 25) score -= 1;
  else                         score -= 2;

  score = Math.max(1, Math.min(10, score));

  if (score >= 8) return { score, label: 'Epic',  color: '#00c853' };
  if (score >= 6) return { score, label: 'Good',  color: '#76c442' };
  if (score >= 4) return { score, label: 'Fair',  color: '#f9a825' };
  if (score >= 2) return { score, label: 'Poor',  color: '#ef6c00' };
  return             { score, label: 'Flat',  color: '#c62828' };
}

// ─── Main per-spot processor ───────────────────────────────────────────────

async function processSpot(spot) {
  console.log(`  Fetching ${spot.name}...`);

  const [waveData, windData, tideData] = await Promise.all([
    fetchWaves(spot.lat, spot.lon),
    fetchWind(spot.lat, spot.lon),
    fetchTides(spot.tideStationId),
  ]);

  // Build hourly array
  const times = waveData.hourly?.time || [];
  const hourly = times.map((time, i) => {
    const waveM   = waveData.hourly.wave_height?.[i] ?? null;
    const waveFt  = mToFt(waveM);
    const swellM  = waveData.hourly.swell_wave_height?.[i] ?? null;
    const swellFt = mToFt(swellM);
    const windSpd = windData.hourly.windspeed_10m?.[i] ?? null;
    const windDir = windData.hourly.winddirection_10m?.[i] ?? null;
    const gustSpd = windData.hourly.windgusts_10m?.[i] ?? null;

    return {
      time,
      wave: {
        heightFt:        waveFt,
        period:          waveData.hourly.wave_period?.[i] ?? null,
        direction:       waveData.hourly.wave_direction?.[i] ?? null,
        directionLabel:  compassLabel(waveData.hourly.wave_direction?.[i]),
      },
      swell: {
        heightFt:        swellFt,
        period:          waveData.hourly.swell_wave_period?.[i] ?? null,
        direction:       waveData.hourly.swell_wave_direction?.[i] ?? null,
        directionLabel:  compassLabel(waveData.hourly.swell_wave_direction?.[i]),
      },
      wind: {
        speedMph:        windSpd != null ? Math.round(windSpd) : null,
        gustsMph:        gustSpd != null ? Math.round(gustSpd) : null,
        direction:       windDir,
        directionLabel:  compassLabel(windDir),
      },
      rating: rateConditions(waveFt, windSpd, windDir, spot.facing),
    };
  });

  // Next 6 tide events
  const now = new Date();
  const upcomingTides = tideData
    .filter(t => new Date(t.t) > now)
    .slice(0, 6)
    .map(t => ({
      time:     t.t,
      type:     t.type === 'H' ? 'High' : 'Low',
      heightFt: parseFloat(t.v),
    }));

  const forecast = {
    spot:        spot.name,
    slug:        spot.slug,
    description: spot.description,
    lat:         spot.lat,
    lon:         spot.lon,
    updated:     new Date().toISOString(),
    tides:       upcomingTides,
    hourly,
    current:     hourly[0] ?? null,
  };

  const outPath = path.join(OUTPUT_DIR, `${spot.slug}.json`);
  fs.writeFileSync(outPath, JSON.stringify(forecast, null, 2));
  console.log(`  ✓ ${spot.slug}.json`);
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🌊 NC Surf Forecast — Data Fetch\n${new Date().toUTCString()}\n`);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const spot of spots) {
    try {
      await processSpot(spot);
    } catch (err) {
      console.error(`  ✗ ${spot.name}: ${err.message}`);
    }
    // Brief pause — be a polite API consumer
    await new Promise(r => setTimeout(r, 600));
  }

  // Write an index file so the frontend knows what spots exist
  const index = spots.map(s => ({
    name:        s.name,
    slug:        s.slug,
    description: s.description,
    lat:         s.lat,
    lon:         s.lon,
  }));
  fs.writeFileSync(
    path.join(__dirname, '../public/data/spots.json'),
    JSON.stringify(index, null, 2)
  );

  console.log('\n✅ Done!\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
