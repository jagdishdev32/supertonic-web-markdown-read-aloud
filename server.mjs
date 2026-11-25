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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as host from './host.cjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA = path.join(HERE, 'media');
const PUBLIC = path.join(HERE, 'public');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(HERE, 'settings.json');
const LIBRARY_DIR = process.env.LIBRARY_DIR || path.join(HERE, 'library');
const LIBRARY_INDEX = path.join(LIBRARY_DIR, 'index.json');
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
  smartPauses: false, // legacy: pre-2026-11-26 boolean, migrated to pauseMode
  pauseMode: 'off', // 'off' | 'compact' (gap shrinks by 1/sqrt(speed)) | 'research' (gap grows per boundary-restoration table)
  pauseMultiplier: 1, // user tuning for the added gap (A/B by ear; 0.7–1.5)
  voiceOverrides: {},
  pronunciations: {},
  readerSettings: { codeBlocks: 'announce', tables: 'skip', announceHeadings: false, highlight: true },
  readerPrefs: null,
  currentSource: '',
  currentDocId: null, // which library file is open (stable 12-hex id)
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
// migrate the original smartPauses boolean → pauseMode ('compact' = the old √-shrink)
if (typeof settings.smartPauses === 'boolean') {
  if (!settings.pauseMode || settings.pauseMode === 'off') settings.pauseMode = settings.smartPauses ? 'compact' : 'off';
  delete settings.smartPauses;
}
const save = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

// Session-only active language, like PlayerPanel.activeLocale: seeded from the
// detected document language on open, changed by the reader's language picker.
let activeLocale = settings.locale || FALLBACK_LOCALE;

/** The standalone app trusts the user's configured endpoint (compose service,
 *  LAN box) — the engine's loopback default is relaxed here, guards stay. */
const ENGINE_OPTS = { allowNonLoopback: true };

let supertonic = null;
let edge = null;

/** The live engine for the current settings, or null for the browser engine. */
function getEngine() {
  if (settings.engine === 'edge') return (edge ??= new host.EdgeEngine());
  if (settings.engine === 'supertonic') {
    if (!supertonic || supertonic.endpoint !== settings.supertonicEndpoint) {
      supertonic?.dispose();
      supertonic = new host.SupertonicHttpEngine({ endpoint: settings.supertonicEndpoint, ...ENGINE_OPTS });
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
      pauseMode: settings.pauseMode,
      pauseMultiplier: settings.pauseMultiplier,
      voiceOverrides: settings.voiceOverrides,
      readerSettings: settings.readerSettings,
      readerPrefs: settings.readerPrefs,
      currentSource: settings.currentSource,
      currentDocId: settings.currentDocId,
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
      new host.SupertonicHttpEngine({ endpoint: String(patch.supertonicEndpoint), ...ENGINE_OPTS }).dispose(); // validate
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
  if (patch.smartPauses !== undefined) {
    // legacy boolean still accepted: true keeps the old compact behavior
    settings.pauseMode = patch.smartPauses ? (settings.pauseMode === 'off' ? 'compact' : settings.pauseMode) : 'off';
  }
  if (patch.pauseMode !== undefined) {
    settings.pauseMode = ['off', 'compact', 'research'].includes(patch.pauseMode) ? patch.pauseMode : settings.pauseMode;
  }
  if (patch.pauseMultiplier !== undefined && Number.isFinite(patch.pauseMultiplier)) {
    settings.pauseMultiplier = Math.min(1.5, Math.max(0.5, patch.pauseMultiplier));
  }
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
  if (patch.currentDocId !== undefined) {
    settings.currentDocId = patch.currentDocId && /^[0-9a-f]{12}$/.test(patch.currentDocId) ? patch.currentDocId : null;
  }
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

/** Append `ms` of silence to a RIFF/WAVE buffer (walks chunks; fixes sizes). */
function appendWavSilence(buf, ms) {
  if (ms <= 0 || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  let pos = 12;
  let dataAt = -1;
  let dataSize = 0;
  let byteRate = 0;
  let blockAlign = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'data') {
      dataAt = pos;
      dataSize = size;
    }
    if (id === 'fmt ') {
      byteRate = buf.readUInt32LE(pos + 16);
      blockAlign = buf.readUInt16LE(pos + 20);
    }
    pos += 8 + size + (size % 2); // chunks are word-aligned
  }
  if (dataAt < 0 || !byteRate || !blockAlign) return buf;
  const silence = Buffer.alloc(Math.round((byteRate * ms) / 1000) - (Math.round((byteRate * ms) / 1000) % blockAlign));
  const out = Buffer.concat([buf, silence]);
  out.writeUInt32LE(dataSize + silence.length, dataAt + 4);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/** Added sentence-end gap (ms) for the current mode and speed. The model's own
 *  trailing silence (~250 ms) is part of the perceived pause: research-mode
 *  totals (350 + 200·(rate−1) + trailing) track the boundary-restoration table
 *  (600/700/800/900 ms at 1/1.5/2/2.5×); compact keeps the old 1/√speed shrink. */
function sentenceGapMs() {
  const rate = Math.min(2.5, Math.max(0.5, settings.rate));
  const mult = Math.min(1.5, Math.max(0.5, settings.pauseMultiplier || 1));
  let gap = 0;
  if (settings.pauseMode === 'compact') gap = 350 / Math.sqrt(rate);
  else if (settings.pauseMode === 'research') gap = 350 + 200 * (rate - 1);
  return Math.round(gap * mult);
}

// ---- document library: named .md files, editable in place ----
// One .md file per document (stable 12-hex id), plus a JSON index. Saving an
// open document overwrites its file; renaming renames the file too.

let libraryIndex = { docs: [] };
try {
  libraryIndex = { docs: JSON.parse(fs.readFileSync(LIBRARY_INDEX, 'utf8')).docs ?? [] };
} catch {
  /* empty library */
}
const saveLibraryIndex = () => {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_INDEX, JSON.stringify(libraryIndex, null, 2));
};

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'doc';

/** Default name: first heading, else first non-blank line. */
function deriveTitle(source) {
  const line =
    /^#{1,6}\s+(.+)$/m.exec(source)?.[1] ??
    source.split('\n').find((l) => l.trim())?.replace(/[#>*_`~\[\]]/g, '').trim() ??
    '';
  return (line || 'Pasted ' + new Date().toISOString().slice(0, 10)).slice(0, 80).trim();
}

// old content-addressed entries carried `title`; treat it as the name
for (const d of libraryIndex.docs) {
  if (d.name === undefined) d.name = d.title ?? 'Untitled';
  delete d.title;
}

/** Create or update a named document. Unknown/absent id creates a new file. */
function librarySave({ id, name, source }) {
  const now = new Date().toISOString();
  let doc = id ? libraryIndex.docs.find((d) => d.id === id) : undefined;
  if (doc) {
    fs.writeFileSync(path.join(LIBRARY_DIR, doc.file), source);
    if (name && name.trim() && name.trim() !== doc.name) {
      doc.name = name.trim().slice(0, 80);
      const file = `${slugify(doc.name)}-${doc.id}.md`;
      fs.renameSync(path.join(LIBRARY_DIR, doc.file), path.join(LIBRARY_DIR, file));
      doc.file = file;
    }
    doc.openedAt = now;
    libraryIndex.docs = [doc, ...libraryIndex.docs.filter((d) => d !== doc)];
  } else {
    const finalName = (name || '').trim().slice(0, 80) || deriveTitle(source);
    doc = { id: crypto.randomBytes(6).toString('hex'), file: '', name: finalName, addedAt: now, openedAt: now };
    doc.file = `${slugify(doc.name)}-${doc.id}.md`;
    fs.mkdirSync(LIBRARY_DIR, { recursive: true });
    fs.writeFileSync(path.join(LIBRARY_DIR, doc.file), source);
    libraryIndex.docs.unshift(doc);
  }
  saveLibraryIndex();
  return doc;
}

function libraryGet(id) {
  if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
  const doc = libraryIndex.docs.find((d) => d.id === id);
  if (!doc) return undefined;
  const file = path.join(LIBRARY_DIR, doc.file);
  if (!file.startsWith(LIBRARY_DIR + path.sep)) return undefined;
  try {
    return { doc, source: fs.readFileSync(file, 'utf8') };
  } catch {
    return undefined;
  }
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

    if (req.method === 'GET' && u.pathname === '/api/library') {
      return json(res, 200, { docs: libraryIndex.docs });
    }

    if (req.method === 'POST' && u.pathname === '/api/library') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const source = String(body.source ?? '');
      if (!source.trim()) return json(res, 422, { message: 'empty document' });
      const doc = librarySave({ id: body.id, name: body.name, source });
      // saving a document makes it the one you're working on
      settings.currentDocId = doc.id;
      save();
      return json(res, 200, { doc });
    }

    if (req.method === 'POST' && u.pathname === '/api/library/open') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const hit = libraryGet(String(body.id ?? ''));
      if (!hit) return json(res, 404, { message: 'document not found' });
      settings.currentSource = hit.source;
      settings.currentDocId = hit.doc.id;
      save();
      const locale = host.detectLocale(hit.source, settings.fallbackLocale).locale;
      activeLocale = locale;
      return json(res, 200, {
        html: host.renderMarkdownHtml(hit.source),
        locale,
        title: hit.doc.name,
        id: hit.doc.id,
        name: hit.doc.name,
        source: hit.source,
      });
    }

    if (req.method === 'DELETE' && u.pathname.startsWith('/api/library/')) {
      const id = u.pathname.slice('/api/library/'.length);
      const hit = libraryGet(id);
      if (!hit) return json(res, 404, { message: 'document not found' });
      fs.rmSync(path.join(LIBRARY_DIR, hit.doc.file), { force: true });
      libraryIndex.docs = libraryIndex.docs.filter((d) => d.id !== id);
      if (settings.currentDocId === id) {
        settings.currentDocId = null; // the file you had open is gone
        save();
      }
      saveLibraryIndex();
      return json(res, 200, { ok: true });
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
        let buf = await engine.synth(clean, voice, locale);
        if (settings.engine === 'supertonic') {
          // Boundary-aware sentence gaps; Edge clips are mp3 — skipped there.
          buf = appendWavSilence(buf, sentenceGapMs());
        }
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
