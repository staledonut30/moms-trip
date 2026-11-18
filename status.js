// status.js — trip config, data fetching, and status logic for "Mom's Trip".
// Pure ES module: no DOM. Runs in Safari/Chrome and Node 20+.
//
//   import { checkTrip } from './status.js';
//   const result = await checkTrip();   // plain object, see evaluate()

// ============================================================================
// CONFIG — edit these
// ============================================================================
export const CONFIG = {
  flight: {
    number: 'DL2218',
    // ⚠️ NOT CONFIRMED from an official source. Check her Delta confirmation
    // email or the Fly Delta app and fix these if they differ. Eastern Time.
    departs: '2026-11-20T12:30:00-05:00', // MCO
    arrives: '2026-11-20T15:20:00-05:00', // DTW (estimate: ~2h50m block time)
  },

  // Show "Welcome home" this many minutes after the scheduled arrival.
  welcomeHomeAfterMinutes: 0,

  // Used only for the page's countdown line.
  shipArrives: '2026-11-20T06:00:00-05:00',

  // Status thresholds (starting points — tune freely).
  thresholds: {
    thunderChancePct: 40,     // YELLOW if thunderstorm chance >= this in a window
    windSustainedMph: 25,     // YELLOW if sustained wind >= this (flight + Detroit)
    windGustMph: 35,          // YELLOW if gusts >= this (flight + Detroit)
    winterPrecipChancePct: 30,// YELLOW if snow/freezing rain chance >= this at DTW
    coatLineAtOrBelowF: 50,   // Detroit: show "keep your coat handy" at/below this
    faaRelevantHoursBefore: 6,// FAA ground stops/delays count only this close to a window
    faaMaxAgeMinutes: 45,     // faa.json older than this = "not checked" (GitHub cron can run late)
    staleAfterMinutes: 90,    // UI: older cached data stops showing a color
  },

  // NWS alerts: "Warning" => RED, "Watch"/"Advisory" => YELLOW.
  alertRules: {
    // Events that never change the color (beach-only / informational).
    ignoreEvents: [
      'Rip Current Statement', 'Beach Hazards Statement', 'Hazardous Weather Outlook',
      'Coastal Flood Statement', 'Hydrologic Outlook', 'Air Quality Alert',
    ],
    // Warnings to treat as YELLOW instead of RED (empty = every warning is RED).
    warningsAsYellow: [],
    // Events that only matter for some sections (e.g. beach surf doesn't affect the drive).
    onlyFor: { 'High Surf Advisory': ['port'], 'High Surf Warning': ['port'] },
  },

  // Counties by FIPS (as NWS reports them in geocode.SAME).
  counties: {
    brevard: { same: '012009', zone: 'FLC009', name: 'Brevard County' },
    orange:  { same: '012095', zone: 'FLC095', name: 'Orange County' },
    wayne:   { same: '026163', zone: 'MIC163', name: 'Wayne County' },
  },

  // FAA data. Browsers can't call the FAA (no CORS), so a GitHub Action
  // (scripts/faa.mjs, every ~10 min) saves it as faa.json next to the page.
  faa: {
    url: 'https://nasstatus.faa.gov/api/airport-events',
    browserUrl: './faa.json',
    airports: ['MCO', 'DTW'],
  },

  // Central Florida box for the hurricane-center cone check (lon/lat).
  tropicalBox: { xmin: -81.6, ymin: 28.0, xmax: -80.3, ymax: 28.9 },
};

// Trip sections in order. Flight/Detroit windows follow the flight times above.
export function buildSections(cfg = CONFIG) {
  const dep = Date.parse(cfg.flight.departs);
  const arr = Date.parse(cfg.flight.arrives);
  const H = 3600e3;
  return [
    {
      id: 'port', title: 'Arriving at Port Canaveral',
      start: Date.parse('2026-11-20T05:00:00-05:00'), end: Date.parse('2026-11-20T09:00:00-05:00'),
      place: { lat: 28.4058, lon: -80.6081, nws: 'MLB/56,66' },
      counties: ['brevard'], airport: null, tropical: true, checkWind: false, checkWinter: false,
    },
    {
      id: 'drive', title: 'The drive to MCO',
      start: Date.parse('2026-11-20T08:00:00-05:00'), end: Date.parse('2026-11-20T11:00:00-05:00'),
      place: { lat: 28.46, lon: -80.95, nws: 'MLB/43,66' }, // SR-528 at the St. Johns River
      counties: ['brevard', 'orange'], airport: null, tropical: true, checkWind: false, checkWinter: false,
    },
    {
      id: 'flight', title: 'Your flight from Orlando',
      start: dep - 2.5 * H, end: dep + 1.5 * H,
      place: { lat: 28.4312, lon: -81.3081, nws: 'MLB/29,64' },
      counties: ['orange'], airport: 'MCO', tropical: true, checkWind: true, checkWinter: false,
    },
    {
      id: 'detroit', title: 'Landing in Detroit',
      start: arr - 2 * H, end: arr + 2 * H,
      place: { lat: 42.2124, lon: -83.3534, nws: 'DTX/56,28' },
      counties: ['wayne'], airport: 'DTW', tropical: false, checkWind: true, checkWinter: true,
    },
  ];
}

// ============================================================================
// FETCHING — every source is optional; failures become `null` + an error note.
// ============================================================================
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const NODE_HEADERS = IS_BROWSER ? {} : { 'User-Agent': 'MomTripWeather/1.0 (personal trip checker)' };

async function getJSON(url, fetchImpl, timeoutMs = 15000) {
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/geo+json, application/json', ...NODE_HEADERS },
    cache: 'no-cache',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

function trimNwsHourly(json, from, to) {
  const periods = json?.properties?.periods;
  if (!Array.isArray(periods) || !periods.length) throw new Error('NWS hourly: unexpected shape');
  return periods
    .filter(p => Date.parse(p.endTime) > from && Date.parse(p.startTime) < to)
    .map(p => ({
      t: Date.parse(p.startTime),
      tempF: p.temperatureUnit === 'C' ? Math.round(p.temperature * 9 / 5 + 32) : p.temperature,
      pop: p.probabilityOfPrecipitation?.value ?? 0,
      windMph: Math.max(0, ...(String(p.windSpeed).match(/\d+/g) || [0]).map(Number)),
      gustMph: null,
      sky: p.shortForecast || '',
    }));
}

const OM_SKY = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Fog',
  51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorms', 96: 'Thunderstorms', 99: 'Thunderstorms' };

function trimOpenMeteo(loc) {
  const h = loc?.hourly;
  if (!h?.time) throw new Error('Open-Meteo: unexpected shape');
  return h.time.map((iso, i) => ({
    t: Date.parse(iso + 'Z'),
    tempF: Math.round(h.temperature_2m[i]),
    pop: h.precipitation_probability[i] ?? 0,
    windMph: Math.round(h.wind_speed_10m[i]),
    gustMph: Math.round(h.wind_gusts_10m[i]),
    sky: OM_SKY[h.weather_code[i]] ?? '',
  }));
}

function faaAirport(a) {
  if (!a) return null; // not on the FAA list = nothing going on there
  const d = a.departureDelay || a.arrivalDelay;
  const range = d?.arrivalDeparture ? `${d.arrivalDeparture.min}–${d.arrivalDeparture.max}`.replace(/ minutes/g, '') + ' minutes' : null;
  return {
    groundStop: !!a.groundStop, groundDelay: !!a.groundDelay, closure: !!a.airportClosure,
    delay: !!d, delayRange: range, deicing: !!a.deicing,
    reason: (a.groundStop || a.groundDelay || a.airportClosure || d)?.reason || null,
  };
}

/** Ask the FAA directly (Node only). Returns { fetchedAt, airports: { MCO, DTW } }. */
export async function fetchFaa({ fetchImpl = globalThis.fetch, cfg = CONFIG, now = Date.now() } = {}) {
  const list = await getJSON(cfg.faa.url, fetchImpl);
  if (!Array.isArray(list)) throw new Error('FAA: unexpected shape');
  const airports = {};
  for (const id of cfg.faa.airports) airports[id] = faaAirport(list.find(a => a.airportId === id));
  return { fetchedAt: now, airports };
}

function checkFaaFile(j) {
  if (!j || typeof j.fetchedAt !== 'number') throw new Error('faa.json: unexpected shape');
  if (!j.ok) throw new Error(`faa.json: last FAA check failed (${j.error || 'unknown'})`);
  return { fetchedAt: j.fetchedAt, airports: j.airports };
}

/** Fetch everything. Returns raw-but-trimmed data; never throws. */
export async function fetchAll({ fetchImpl = globalThis.fetch, cfg = CONFIG, now = Date.now(), inBrowser = IS_BROWSER } = {}) {
  const sections = buildSections(cfg);
  const from = Math.min(...sections.map(s => s.start)) - 3600e3;
  const to = Math.max(...sections.map(s => s.end)) + 3600e3;
  const errors = [];
  const wrap = (name, p) => p.catch(e => { errors.push(`${name}: ${e.message}`); return null; });

  const zones = Object.values(cfg.counties).map(c => c.zone).join(',');
  const omUrl = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: sections.map(s => s.place.lat).join(','),
    longitude: sections.map(s => s.place.lon).join(','),
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m',
    temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', timezone: 'GMT',
    start_hour: new Date(Math.max(from, now - 3600e3)).toISOString().slice(0, 13) + ':00',
    end_hour: new Date(Math.max(to, now)).toISOString().slice(0, 13) + ':00',
  });
  const b = cfg.tropicalBox;
  const coneQuery = id => `https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer/${id}/query?` +
    new URLSearchParams({ geometry: `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`, geometryType: 'esriGeometryEnvelope',
      inSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' });

  const [nws, om, alerts, faa, nhc] = await Promise.all([
    Promise.all(sections.map(s => wrap(`NWS ${s.id}`,
      getJSON(`https://api.weather.gov/gridpoints/${s.place.nws}/forecast/hourly`, fetchImpl).then(j => trimNwsHourly(j, from, to))))),
    wrap('Open-Meteo', getJSON(omUrl, fetchImpl).then(j => (Array.isArray(j) ? j : [j]).map(trimOpenMeteo))),
    wrap('NWS alerts', getJSON(`https://api.weather.gov/alerts/active?status=actual&zone=${zones}`, fetchImpl).then(j => {
      if (!Array.isArray(j?.features)) throw new Error('unexpected shape');
      return j.features.map(f => f.properties).filter(p => p.messageType !== 'Cancel').map(p => ({
        id: p.id, event: p.event, headline: p.headline, areaDesc: p.areaDesc,
        same: p.geocode?.SAME || [],
        start: Date.parse(p.onset || p.effective), end: p.ends ? Date.parse(p.ends) : null,
      }));
    })),
    // Browser: read faa.json (written by the GitHub Action). Node: ask the FAA directly.
    wrap('FAA', inBrowser ? getJSON(cfg.faa.browserUrl, fetchImpl).then(checkFaaFile) : fetchFaa({ fetchImpl, cfg })),
    // Atlantic storms AT1–AT5: does any forecast cone touch central Florida?
    wrap('NHC', Promise.all([8, 34, 60, 86, 112].map(id => getJSON(coneQuery(id), fetchImpl)))
      .then(rs => {
        if (rs.some(r => typeof r?.count !== 'number')) throw new Error('unexpected shape');
        return { threatensCentralFL: rs.some(r => r.count > 0) };
      })),
  ]);

  return { fetchedAt: now, nws, om, alerts, faa, nhc, errors };
}

// ============================================================================
// STATUS LOGIC — pure functions
// ============================================================================
const RANK = { done: -1, green: 0, unknown: 1, yellow: 2, red: 3 };
export const LABELS = {
  green: { emoji: '🟢', label: 'Looking good' },
  yellow: { emoji: '🟡', label: 'Something to keep an eye on' },
  red: { emoji: '🔴', label: 'Action needed' },
  unknown: { emoji: '⚪', label: "Couldn't fully check" },
  done: { emoji: '✔️', label: 'Done' },
  home: { emoji: '🏠', label: 'Welcome home to Detroit!' },
};
const worst = list => list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'done');

export function formatTime(ms) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(ms);
}
function hourLabel(ms) {
  const s = formatTime(ms);
  return s.replace(':00', '');
}
function windowLabel(s) {
  const a = hourLabel(s.start), b = hourLabel(s.end);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `Fri ${sameHalf ? a.slice(0, -3) : a}–${b}`;
}

function alertLevel(event, rules) {
  if (rules.ignoreEvents.includes(event)) return null;
  if (/Warning$/i.test(event)) return rules.warningsAsYellow.includes(event) ? 'yellow' : 'red';
  if (/(Watch|Advisory)$/i.test(event)) return 'yellow';
  return 'info'; // statements: shown, no color change
}

const WHERE = { port: 'where the port is', drive: 'along your drive to the airport', flight: 'around the Orlando airport during your flight time', detroit: 'around the Detroit airport when you land' };

function alertCopy(a, level, sec, county) {
  const e = a.event;
  if (level === 'red') {
    const lead = `The weather service has a ${e} for ${county}, ${WHERE[sec.id]}.`;
    if (sec.id === 'port') return `${lead} Listen to the ship's announcements, and ask the cruise staff whether the roads to the airport are clear before you leave.`;
    if (sec.id === 'drive') return `${lead} Ask the cruise staff or your driver whether the route is open, leave extra time, and check the Delta app before you head to the airport.`;
    return `${lead} Check the Delta app or call Delta before you head to the airport.`;
  }
  if (level === 'yellow') {
    if (/Fog/i.test(e)) return {
      port: 'Morning fog is expected. Fog can slow docking down a little. That\'s routine, and the crew deals with it all the time.',
      drive: 'Morning fog is expected on the roads. Headlights on and take it slow. Fog usually lifts by mid-morning.',
    }[sec.id] || 'Fog is expected. It can cause short delays, so keep an eye on the Delta app.';
    if (/Winter Weather Advisory/i.test(e)) return 'A snowy landing is possible, which Detroit handles all the time.';
    if (/Flood Watch/i.test(e)) return sec.id === 'flight'
      ? 'Heavy rain is possible around Orlando. Planes take off in rain every day. Just give yourself extra time getting to the airport.'
      : 'Officials say heavy rain could cause some flooding in the area. Leave a little extra time for the drive.';
    if (/High Surf/i.test(e)) return 'The ocean is rough near the beaches. Big ships handle this fine; the last stretch may just feel bumpier.';
    if (/Wind Advisory/i.test(e)) return 'It\'s expected to be windy. Takeoff or landing could feel bumpy.';
    if (/Tropical Storm Watch|Hurricane Watch/i.test(e)) return 'Forecasters are watching a tropical storm that could reach the area. Keep checking here and in the Delta app.';
    if (/Freeze|Frost/i.test(e)) return 'It\'s expected to be very cold. Bundle up.';
    return `The weather service has a ${e} for ${county}. It's worth keeping an eye on.`;
  }
  return a.headline || e;
}

function summarize(hours) {
  if (!hours.length) return null;
  const temps = hours.map(h => h.tempF);
  const counts = {};
  for (const h of hours) counts[h.sky] = (counts[h.sky] || 0) + 1;
  const sky = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const gusts = hours.map(h => h.gustMph).filter(g => g != null);
  const isThunder = h => /thunder/i.test(h.sky);
  const isSnow = h => /snow|flurr|sleet|wintry/i.test(h.sky);
  const isIce = h => /freezing|sleet|ice/i.test(h.sky);
  return {
    tempLo: Math.min(...temps), tempHi: Math.max(...temps),
    precipPct: Math.max(...hours.map(h => h.pop)),
    thunderPct: Math.max(0, ...hours.filter(isThunder).map(h => h.pop)),
    snowPct: Math.max(0, ...hours.filter(isSnow).map(h => h.pop)),
    icePct: Math.max(0, ...hours.filter(isIce).map(h => h.pop)),
    windMph: Math.max(...hours.map(h => h.windMph)),
    gustMph: gusts.length ? Math.max(...gusts) : null,
    sky: sky ? sky[0].toUpperCase() + sky.slice(1).toLowerCase() : '',
  };
}

function weatherPhrase(w) {
  const t = w.tempLo === w.tempHi ? `${w.tempHi}°F` : `${w.tempLo}–${w.tempHi}°F`;
  const wind = w.windMph <= 10 ? 'light winds' : `winds up to ${w.windMph} mph`;
  return `${w.sky}, ${t}, ${wind}`;
}

function evaluateSection(sec, raw, idx, now, cfg) {
  const T = cfg.thresholds;
  const out = {
    id: sec.id, title: sec.title, when: windowLabel(sec), start: sec.start, end: sec.end,
    status: 'green', headline: '', reasons: [], tips: [], alerts: [], weather: null, source: null, notes: [], airport: null,
  };
  if (now >= sec.end) { out.status = 'done'; out.headline = 'This part of the trip is done.'; return out; }

  const levels = [];
  const add = (level, text, short) => { levels.push(level); out.reasons.push({ level, text, short }); };

  // --- Forecast (NWS first, Open-Meteo backup) ---------------------------------
  const from = Math.max(sec.start, now - 3600e3);
  const inWin = h => h.t + 3600e3 > from && h.t < sec.end;
  let hours = raw.nws?.[idx]?.filter(inWin) || [];
  const omHours = raw.om?.[idx]?.filter(inWin) || [];
  if (hours.length) {
    out.source = 'National Weather Service';
    for (const h of hours) { // borrow gusts from Open-Meteo (NWS hourly has none)
      const m = omHours.find(o => o.t === h.t);
      if (m) h.gustMph = m.gustMph;
    }
  } else if (omHours.length) {
    hours = omHours; out.source = 'Open-Meteo (backup)';
    out.notes.push('The weather service forecast didn\'t load, so this uses a backup forecast.');
  }
  const w = summarize(hours);
  out.weather = w;
  if (!w) { levels.push('unknown'); out.notes.push('Couldn\'t get the forecast for this part.'); }

  // --- NWS alerts ----------------------------------------------------------------
  if (!raw.alerts) {
    levels.push('unknown'); out.notes.push('Couldn\'t check weather alerts just now.');
  } else {
    const fips = sec.counties.map(c => cfg.counties[c].same);
    const seen = new Set();
    for (const a of raw.alerts) {
      if (!a.same.some(s => fips.includes(s))) continue;
      if (!(a.start < sec.end && (a.end == null || a.end > sec.start))) continue;
      const only = cfg.alertRules.onlyFor[a.event];
      if (only && !only.includes(sec.id)) continue;
      const level = alertLevel(a.event, cfg.alertRules);
      if (!level || seen.has(a.event)) continue;
      seen.add(a.event);
      const county = sec.counties.map(c => cfg.counties[c]).filter(c => a.same.includes(c.same)).map(c => c.name).join(' and ');
      const text = alertCopy(a, level, sec, county);
      out.alerts.push({ event: a.event, level, text, headline: a.headline });
      if (level !== 'info') add(level, text, `${/^[AEIOU]/i.test(a.event) ? 'an' : 'a'} ${a.event}`);
    }
  }

  // --- Hurricane center ----------------------------------------------------------
  if (sec.tropical) {
    if (raw.nhc?.threatensCentralFL) add('red', 'The National Hurricane Center is tracking a tropical storm that could affect central Florida. Listen to the ship\'s announcements, and check the Delta app or call Delta before you head to the airport.', 'a hurricane center storm alert');
    else if (!raw.nhc) out.notes.push('Couldn\'t reach the hurricane center just now.');
  }

  // --- FAA -----------------------------------------------------------------------
  if (sec.airport) {
    const city = sec.airport === 'MCO' ? 'Orlando' : 'Detroit';
    const faa = raw.faa;
    const fresh = faa && now - faa.fetchedAt <= T.faaMaxAgeMinutes * 60e3;
    out.airport = { checked: false, asOf: faa?.fetchedAt ?? null, text: '' };
    if (!faa) out.airport.text = 'Couldn\'t check FAA airport delays just now. Use the FAA button below.';
    else if (!fresh) out.airport.text = `The FAA airport info is out of date (from ${formatTime(faa.fetchedAt)}). Use the FAA button below.`;
    else {
      const f = faa.airports?.[sec.airport] ?? null;
      const asOf = `(FAA, as of ${formatTime(faa.fetchedAt)})`;
      const relevant = now >= sec.start - T.faaRelevantHoursBefore * 3600e3;
      const why = f?.reason && /^WX:/i.test(f.reason) ? ` because of ${f.reason.slice(3).trim().toLowerCase()}` : '';
      out.airport.checked = true;
      if (!f || !(f.groundStop || f.groundDelay || f.closure || f.delay)) {
        out.airport.text = `No delays reported at ${city} ${asOf}.`;
        if (f?.deicing && relevant) out.airport.text += ` Planes are being de-iced there, which is routine in cold weather and can add a few minutes.`;
      } else if (!relevant) {
        out.airport.text = `The FAA shows delays at ${city} right now${why}, but that's well before your trip, so it doesn't count yet ${asOf}.`;
      } else if (f.groundStop || f.groundDelay || f.closure) {
        out.airport.text = `The FAA is holding or slowing flights at ${city}${why} ${asOf}.`;
        add('red', `The FAA is holding or slowing flights at ${city}${why}. Check the Delta app or call Delta before you head to the airport.`, `an FAA hold on flights at ${city}`);
      } else {
        out.airport.text = `The FAA reports delays at ${city}${f.delayRange ? ` of ${f.delayRange}` : ''}${why} ${asOf}.`;
        add('yellow', `The FAA is reporting some delays at ${city}${why}. Keep an eye on the Delta app for your flight.`, `a delay report from the FAA at ${city}`);
      }
    }
  }

  // --- Forecast thresholds -------------------------------------------------------
  if (w) {
    if (w.thunderPct >= T.thunderChancePct) {
      const msg = {
        port: `Thunderstorms are possible while the ship docks (${w.thunderPct}% chance). Docking may wait a bit for a storm to pass. That's normal.`,
        drive: `Thunderstorms are possible on the drive (${w.thunderPct}% chance). Take it slow and leave extra time.`,
        flight: `Thunderstorms are possible around takeoff (${w.thunderPct}% chance). Storms can cause short delays, so keep an eye on the Delta app.`,
        detroit: `Thunderstorms are possible when you land (${w.thunderPct}% chance). That can cause short delays.`,
      }[sec.id];
      add('yellow', msg, 'a chance of thunderstorms');
    }
    if (sec.checkWind && (w.windMph >= T.windSustainedMph || (w.gustMph ?? 0) >= T.windGustMph)) {
      const g = w.gustMph && w.gustMph >= T.windGustMph ? `, gusts to ${w.gustMph} mph` : '';
      add('yellow', `It'll be windy (${w.windMph} mph${g}). ${sec.id === 'flight' ? 'Takeoff' : 'The landing'} may be bumpy, and wind can cause delays. Check the Delta app.`, 'strong wind');
    }
    if (sec.checkWinter) {
      if (w.icePct >= T.winterPrecipChancePct) add('yellow', `Freezing rain is possible when you land (${w.icePct}% chance). That can slow things down, so check the Delta app before you leave Orlando.`, 'a chance of freezing rain');
      else if (w.snowPct >= T.winterPrecipChancePct && !out.alerts.some(a => /Winter Weather Advisory/i.test(a.event)))
        add('yellow', `Snow is possible when you land (${w.snowPct}% chance). Detroit's airport clears snow fast, and they handle this all the time.`, 'a chance of snow');
    }
    if (sec.id === 'detroit') {
      const arr = Date.parse(cfg.flight.arrives);
      const atLanding = hours.reduce((a, b) => (Math.abs(b.t - arr) < Math.abs(a.t - arr) ? b : a));
      if (atLanding.tempF <= T.coatLineAtOrBelowF)
        out.tips.push(`It'll be about ${atLanding.tempF}°F when you land, so keep your coat handy${atLanding.tempF <= 32 ? ' and bundle up' : ''}.`);
    }
  }

  out.status = worst(levels.length ? levels : ['green']);
  if (out.status === 'done') out.status = 'green';

  // --- One-line headline ---------------------------------------------------------
  const top = out.reasons.filter(r => r.level === out.status);
  if (top.length) out.headline = top[0].text;
  else if (out.status === 'unknown') out.headline = out.notes[0] || 'Couldn\'t check this part just now.';
  else if (w) {
    const wet = w.precipPct >= 50;
    out.headline = {
      port: wet ? `${weatherPhrase(w)}. Some rain while you dock, but nothing worrying. Have an umbrella handy.` : `${weatherPhrase(w)}. A normal morning to come into port.`,
      drive: wet ? `${weatherPhrase(w)}. A rainy drive, so just take it easy.` : `${weatherPhrase(w)}. A normal drive.`,
      flight: wet ? `${weatherPhrase(w)}. Rain is likely around takeoff. Planes take off in rain every day.` : `${weatherPhrase(w)} at departure time. Normal flying weather.`,
      detroit: `${weatherPhrase(w)} when you land. Normal landing weather.`,
    }[sec.id];
  }
  return out;
}

const PLACE = { port: 'the port', drive: 'the drive to the airport', flight: 'your flight from Orlando', detroit: 'your landing in Detroit' };
const listJoin = a => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`);

/** Turn fetched data into the status object. Pure: same input → same output. */
export function evaluate(raw, now = raw.fetchedAt, cfg = CONFIG) {
  const sections = buildSections(cfg).map((s, i) => evaluateSection(s, raw, i, now, cfg));
  const homeAt = Date.parse(cfg.flight.arrives) + cfg.welcomeHomeAfterMinutes * 60e3;
  const base = { checkedAt: raw.fetchedAt, flight: { ...cfg.flight }, errors: raw.errors || [], sections };

  if (now >= homeAt) {
    return { ...base, status: 'home', ...LABELS.home, sentence: 'We hope it was a wonderful trip. Nothing left to watch.', home: true };
  }
  const status = worst(sections.map(s => s.status));
  let sentence;
  if (status === 'green') sentence = 'The weather looks calm for every part of the trip that\'s left.';
  else if (status === 'unknown') sentence = 'Some information didn\'t load. Try again in a few minutes, or use the Delta app for your flight.';
  else {
    const hit = sections.filter(s => s.status === status);
    const shorts = [...new Set(hit.flatMap(s => s.reasons.filter(r => r.level === status).map(r => r.short)))];
    const what = shorts.length > 2 ? `${shorts.slice(0, 2).join(', ')}, and more` : shorts.join(' and ');
    const where = listJoin(hit.map(s => PLACE[s.id]));
    sentence = status === 'red'
      ? `There's ${what} affecting ${where}. See what to do below, and check the Delta app or call Delta before you head to the airport.`
      : `There's ${what} affecting ${where}. Details are below.`;
  }
  return { ...base, status, ...LABELS[status], sentence, home: false };
}

/** Fetch + evaluate. The one call phase 2 (Node alerts) needs. */
export async function checkTrip(opts = {}) {
  const raw = await fetchAll(opts);
  const allFailed = !raw.alerts && !raw.om && raw.nws.every(x => !x);
  if (allFailed) {
    const err = new Error('Could not reach any weather source');
    err.raw = raw;
    throw err;
  }
  return evaluate(raw, opts.now ?? raw.fetchedAt, opts.cfg ?? CONFIG);
}
