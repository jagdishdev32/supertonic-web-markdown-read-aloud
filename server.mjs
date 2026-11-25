/**
 * Standalone Read Aloud web app — a zero-dependency local server that pairs the
 * extension's reader UI (served from ../media) with its TTS engines. Binds to
 * loopback only. Text never leaves the machine in Supertonic mode.
 *
 *   node server.mjs            → http://127.0.0.1:7789
 *
 * Run from anywhere: paths below are resolved relative to this file.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as host from './host.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(HERE, 'media');
const PUBLIC = path.join(HERE, 'public');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(HERE, 'settings.json');
const PORT = Number(process.env.PORT) || 7789;
// 0.0.0.0 inside containers (via HOST env), loopback only when run bare.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 2 * 1024 * 1024;
const MAX_SYNTH_INPUT = 5000; // playerPanel's host-side cap
const FALLBACK_LOCALE = 'en-US';

const DEFAULTS = {
  engine: 'supertonic', // 'supertonic' | 'edge' | 'browser'
  supertonicEndpoint: host.SUPERTONIC_DEFAULT_ENDPOINT,
  gender: 'female',
  autoLang: false, // perParagraphLanguage
  fallbackLocale: FALLBACK_LOCALE,
  rate: 1,
  volume: 1,
  voiceOverrides: {},
  pronunciations: {},
  readerSettings: { codeBlocks: 'announce', tables: 'skip', announceHeadings: false, highlight: true },
  readerPrefs: null,
  currentSource: '',
};

let settings = { ...DEFAULTS };
try {
  settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch {
  /* first run */
}
// env wins over the stored setting (docker compose points us at the bundled
// supertonic service, or at a server on the host via host.docker.internal)
if (process.env.SUPERTONIC_ENDPOINT) settings.supertonicEndpoint = process.env.SUPERTONIC_ENDPOINT;
const save = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

// Session-only active language, like PlayerPanel.activeLocale: seeded from the
// detected document language on open, changed by the reader's language picker.
let activeLocale = settings.locale || FALLBACK_LOCALE;

let supertonic = null;
let edge = null;

/** The live engine for the current settings, or null for the browser engine. */
function getEngine() {
  if (settings.engine === 'edge') return (edge ??= new host.EdgeEngine());
  if (settings.engine === 'supertonic') {
    if (!supertonic || supertonic.endpoint !== settings.supertonicEndpoint) {
      supertonic?.dispose();
      supertonic = new host.SupertonicHttpEngine({ endpoint: settings.supertonicEndpoint });
      supertonic.endpoint = settings.supertonicEndpoint;
    }
    return supertonic;
  }
  return null;
}

/** Mirror of PlayerPanel.provideSynth's locale/voice resolution. */
function resolveVoice(text, docLocale) {
  const locale = settings.autoLang
    ? host.detectReliableLocale(text) || docLocale || activeLocale
    : activeLocale;
  let voice = host.pickVoice(locale, settings.gender, settings.voiceOverrides);
  if (settings.engine === 'supertonic') voice = host.supertonicStyleFor(settings.voiceOverrides, locale, settings.gender);
  return { locale, voice };
}

function voiceUi() {
  const pair = host.curatedPair(activeLocale);
  const current = host.pickVoice(activeLocale, settings.gender, settings.voiceOverrides);
  return {
    autoLang: settings.autoLang,
    locale: activeLocale,
    localeName: host.localeDisplay(settings.locale),
    locales: host.allCuratedLocales(),
    voicePair: {
      female: pair.female ? { shortName: pair.female, name: host.displayName(pair.female) } : undefined,
      male: pair.male ? { shortName: pair.male, name: host.displayName(pair.male) } : undefined,
    },
    allVoices: host.voicesForLocale(settings.locale).map((v) => ({
      shortName: v.shortName,
      name: host.displayName(v.shortName),
      gender: v.gender.toLowerCase(),
      multilingual: v.multilingual,
    })),
    currentVoice: current,
    currentVoiceName: host.displayName(current),
    gender: settings.gender,
  };
}

async function health() {
  if (settings.engine !== 'supertonic') return { supertonicOk: true, healthError: '' };
  try {
    await getEngine().health();
    return { supertonicOk: true, healthError: '' };
  } catch (err) {
    return { supertonicOk: false, healthError: String(err?.message || err) };
  }
}

function snapshot() {
  return {
    settings: {
      engine: settings.engine,
      supertonicEndpoint: settings.supertonicEndpoint,
      gender: settings.gender,
      autoLang: settings.autoLang,
      rate: settings.rate,
      volume: settings.volume,
      voiceOverrides: settings.voiceOverrides,
      readerSettings: settings.readerSettings,
      readerPrefs: settings.readerPrefs,
      currentSource: settings.currentSource,
    },
    voiceUi: voiceUi(),
  };
}

function json(res, code, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...headers });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Merge a partial settings object; returns an error string or null. */
function applySettings(patch) {
  if (!patch || typeof patch !== 'object') return 'invalid settings';
  if (patch.engine !== undefined) {
    if (!['supertonic', 'edge', 'browser'].includes(patch.engine)) return 'unknown engine';
    settings.engine = patch.engine;
  }
  if (patch.supertonicEndpoint !== undefined) {
    try {
      new host.SupertonicHttpEngine({ endpoint: String(patch.supertonicEndpoint) }).dispose(); // validates loopback http
    } catch (err) {
      return String(err?.message || err);
    }
    settings.supertonicEndpoint = String(patch.supertonicEndpoint);
    supertonic?.dispose();
    supertonic = null;
  }
  if (patch.gender !== undefined) settings.gender = patch.gender === 'male' ? 'male' : 'female';
  if (patch.autoLang !== undefined) settings.autoLang = !!patch.autoLang;
  if (patch.locale !== undefined && typeof patch.locale === 'string' && patch.locale) activeLocale = patch.locale;
  if (patch.rate !== undefined && Number.isFinite(patch.rate)) settings.rate = Math.min(2.5, Math.max(0.5, patch.rate));
  if (patch.volume !== undefined && Number.isFinite(patch.volume)) settings.volume = Math.min(1, Math.max(0, patch.volume));
  if (patch.readerSettings !== undefined && typeof patch.readerSettings === 'object') {
    settings.readerSettings = { ...settings.readerSettings, ...patch.readerSettings };
  }
  if (patch.readerPrefs !== undefined) settings.readerPrefs = patch.readerPrefs ?? null;
  for (const key of ['voiceOverrides', 'pronunciations']) {
    if (patch[key] === undefined) continue;
    if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) return `${key} must be an object`;
    for (const [k, v] of Object.entries(patch[key])) {
      if (typeof v !== 'string') return `${key} values must be strings`;
      if (k.length > 200 || v.length > 500) return `${key} entry too long`;
    }
    settings[key] = patch[key];
  }
  if (patch.currentSource !== undefined) settings.currentSource = String(patch.currentSource).slice(0, MAX_BODY);
  save();
  return null;
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { message: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return serveFile(res, path.join(PUBLIC, 'index.html'));
    }
    if (req.method === 'GET' && u.pathname.startsWith('/media/')) {
      const rel = path.normalize(u.pathname.slice('/media/'.length)).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(MEDIA, rel);
      if (!file.startsWith(MEDIA + path.sep)) return json(res, 403, { message: 'forbidden' });
      return serveFile(res, file);
    }
    if (req.method === 'GET' && (u.pathname === '/app.js' || u.pathname === '/app.css')) {
      return serveFile(res, path.join(PUBLIC, u.pathname.slice(1)));
    }

    if (req.method === 'GET' && u.pathname === '/api/state') {
      let doc = null;
      if (settings.currentSource.trim()) {
        const locale = host.detectLocale(settings.currentSource, settings.fallbackLocale).locale;
        activeLocale = locale; // opening a document seeds the active language
        doc = {
          html: host.renderMarkdownHtml(settings.currentSource),
          locale,
          title: 'Pasted document',
        };
      }
      return json(res, 200, { ...snapshot(), doc, ...(await health()) });
    }

    if (req.method === 'POST' && u.pathname === '/api/render') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const source = String(body.source ?? '');
      if (!source.trim()) return json(res, 422, { message: 'empty document' });
      const html = host.renderMarkdownHtml(source);
      const locale = host.detectLocale(source, settings.fallbackLocale).locale;
      activeLocale = locale;
      return json(res, 200, { html, locale });
    }

    if (req.method === 'POST' && u.pathname === '/api/synth') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const clean = host.applyPronunciations(
        host.normalizeForSpeech(String(body.text ?? '')),
        settings.pronunciations
      );
      if (!clean) return json(res, 422, { message: 'nothing speakable in this sentence' });
      if (clean.length > MAX_SYNTH_INPUT) return json(res, 413, { message: 'sentence too long' });
      const engine = getEngine();
      if (!engine) return json(res, 400, { message: 'the browser engine synthesizes locally — no server call' });
      const { locale, voice } = resolveVoice(clean, String(body.docLocale ?? ''));
      if (settings.engine === 'supertonic' && clean.length > host.SUPERTONIC_MAX_INPUT_LENGTH) {
        return json(res, 413, { message: `input exceeds ${host.SUPERTONIC_MAX_INPUT_LENGTH} characters` });
      }
      try {
        const buf = await engine.synth(clean, voice, locale);
        console.log(`[synth] ${settings.engine} ${locale} ${voice} ${clean.length} chars → ${buf.length} bytes`);
        res.writeHead(200, {
          'content-type': engine.mime,
          'content-length': buf.length,
          'x-locale': locale,
          'cache-control': 'no-store',
        });
        return res.end(buf);
      } catch (err) {
        console.error(`[synth] failed: ${String(err?.message || err)}`);
        return json(res, 502, { message: String(err?.message || err) });
      }
    }

    if (req.method === 'POST' && u.pathname === '/api/settings') {
      const patch = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const err = applySettings(patch);
      if (err) return json(res, 400, { message: err });
      // a voice/engine change can switch engines — recheck reachability
      return json(res, 200, { ...snapshot(), ...(await health()) });
    }

    return json(res, 404, { message: 'not found' });
  } catch (err) {
    return json(res, 500, { message: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Read Aloud app → http://${HOST}:${PORT}  (engine: ${settings.engine})`);
  console.log('Tip: for a desktop-style window run  chromium|google-chrome --app=http://127.0.0.1:7789');
});
