// demo.js: fake data for ?demo=green|yellow|red|faa|error|home. Loaded only in demo mode.
// It goes through the same evaluate() as live data, so it tests the real logic.
import { CONFIG, buildSections, evaluate } from './status.js';

const NOW = Date.parse('2026-11-19T20:00:00-05:00'); // Thu 8 PM, the night before
const FRI_EARLY = Date.parse('2026-11-20T06:30:00-05:00'); // ship docking; FAA data counts now
const H = 3600e3;

function hours(sec, w) {
  const out = [];
  for (let t = sec.start - H; t < sec.end + H; t += H) out.push({ t, gustMph: null, ...w });
  return out;
}

const calm = {
  port:    { tempF: 68, pop: 5,  windMph: 8,  sky: 'Mostly sunny' },
  drive:   { tempF: 72, pop: 5,  windMph: 9,  sky: 'Sunny' },
  flight:  { tempF: 76, pop: 5,  windMph: 10, sky: 'Sunny' },
  detroit: { tempF: 41, pop: 10, windMph: 9,  sky: 'Partly cloudy' },
};

const alert = (event, counties, start, end) => ({
  id: event, event, headline: `${event} (demo)`, areaDesc: '', same: counties,
  start: Date.parse(start), end: end ? Date.parse(end) : null,
});

const SCENARIOS = {
  green: { wx: calm, alerts: [], nhc: false },
  faa: { wx: calm, alerts: [], nhc: false, now: FRI_EARLY,
    faa: { MCO: { groundStop: false, groundDelay: false, closure: false, delay: true, delayRange: '16–30 minutes', deicing: false, reason: 'WX:Thunderstorms' } } },
  yellow: {
    wx: {
      ...calm,
      port: { tempF: 66, pop: 10, windMph: 5, sky: 'Patchy fog' },
      detroit: { tempF: 31, pop: 60, windMph: 14, sky: 'Light snow likely' },
    },
    alerts: [
      alert('Dense Fog Advisory', ['012009'], '2026-11-20T02:00:00-05:00', '2026-11-20T09:00:00-05:00'),
      alert('Winter Weather Advisory', ['026163'], '2026-11-20T10:00:00-05:00', '2026-11-21T04:00:00-05:00'),
    ],
    nhc: false,
  },
  red: {
    wx: {
      ...calm,
      port: { tempF: 78, pop: 90, windMph: 35, sky: 'Tropical storm conditions' },
      drive: { tempF: 78, pop: 90, windMph: 32, sky: 'Heavy rain' },
      flight: { tempF: 79, pop: 85, windMph: 30, sky: 'Showers and thunderstorms' },
    },
    alerts: [
      alert('Tropical Storm Warning', ['012009', '012095'], '2026-11-19T17:00:00-05:00', null),
    ],
    nhc: true,
    now: FRI_EARLY,
    faa: { MCO: { groundStop: true, groundDelay: false, closure: false, delay: false, delayRange: null, deicing: false, reason: 'WX:Thunderstorms' } },
  },
};

function rawFor(name, fetchedAt) {
  const sc = SCENARIOS[name] || SCENARIOS.green;
  fetchedAt ??= sc.now ?? NOW;
  const secs = buildSections(CONFIG);
  return {
    fetchedAt,
    nws: secs.map(s => hours(s, sc.wx[s.id])),
    om: secs.map(s => hours(s, { ...sc.wx[s.id], gustMph: sc.wx[s.id].windMph + 8 })),
    alerts: sc.alerts,
    faa: { fetchedAt: fetchedAt - 4 * 60e3, airports: { MCO: null, DTW: null, ...sc.faa } },
    nhc: { threatensCentralFL: sc.nhc },
    errors: [],
  };
}

/** Returns a result, or throws an Error with `.cached` (like a failed live check). */
export function demoResult(name) {
  if (name === 'home') return evaluate(rawFor('green', NOW + 20 * H), NOW + 20 * H);
  if (name === 'error') {
    const err = new Error('Demo: network down');
    err.cached = evaluate(rawFor('green', NOW - 48 * 60e3), NOW - 48 * 60e3);
    err.now = NOW;
    throw err;
  }
  const raw = rawFor(name);
  return evaluate(raw, raw.fetchedAt);
}
export const DEMO_NOW = NOW;
