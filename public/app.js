/**
 * Browser-side host for the reader UI. Plays the role PlayerPanel plays in the
 * extension: routes reader messages to the local server and dispatches host
 * messages back into the page. reader.js is used unmodified.
 */
(async () => {
  'use strict';
  const KOFI_URL = 'https://ko-fi.com/robinreiche';
  const $ = (id) => document.getElementById(id);

  // ---- overlay DOM (fab, banner, modals) -----------------------------------
  const fab = document.createElement('button');
  fab.className = 'raloud-fab';
  fab.textContent = '✎ Paste markdown';
  fab.title = 'Paste or edit the markdown (Ctrl+Shift+V)';
  document.body.appendChild(fab);

  const banner = document.createElement('div');
  banner.className = 'raloud-banner';
  banner.hidden = true;
  document.body.appendChild(banner);

  const editor = document.createElement('div');
  editor.className = 'raloud-ov';
  editor.hidden = true;
  editor.innerHTML = `
    <div class="raloud-card">
      <h2>Document</h2>
      <div id="raloud-recent"></div>
      <div class="raloud-row" style="margin:0 0 8px">
        <button id="raloud-manage" type="button" class="raloud-linkbtn">Manage all documents…</button>
      </div>
      <input type="text" id="raloud-name" placeholder="Document name (auto from first heading)" style="margin-bottom:8px" spellcheck="false" />
      <textarea id="raloud-src" spellcheck="false" placeholder="Paste markdown here…"></textarea>
      <div class="raloud-row" style="margin-top:12px">
        <button id="raloud-new" type="button" title="Start a new document">New</button>
        <button id="raloud-clip" type="button">Paste from clipboard</button>
        <span style="flex:1"></span>
        <button id="raloud-cancel" type="button">Cancel</button>
        <button id="raloud-save" type="button">Save</button>
        <button id="raloud-go" type="button" class="primary">Render &amp; read</button>
      </div>
      <div class="raloud-hint">Ctrl+Shift+V opens this · everything stays on this machine</div>
      <div class="err" id="raloud-err"></div>
    </div>`;
  document.body.appendChild(editor);

  const manager = document.createElement('div');
  manager.className = 'raloud-ov';
  manager.hidden = true;
  manager.innerHTML = `
    <div class="raloud-card">
      <h2>Library</h2>
      <div id="raloud-manage-list"></div>
      <div class="raloud-hint">Files live in <span id="raloud-libdir">data/library</span> as plain .md — safe to copy or back up.</div>
      <div class="raloud-row" style="margin-top:14px"><span style="flex:1"></span>
        <button id="raloud-manage-close" type="button" class="primary">Close</button>
      </div>
      <div class="err" id="raloud-manage-err"></div>
    </div>`;
  document.body.appendChild(manager);

  const conf = document.createElement('div');
  conf.className = 'raloud-ov';
  conf.hidden = true;
  conf.innerHTML = `
    <div class="raloud-card">
      <h2>App settings</h2>
      <label>Engine</label>
      <div class="raloud-row" id="raloud-engines"></div>
      <label>Supertonic endpoint</label>
      <input type="text" id="raloud-endpoint" spellcheck="false" />
      <div class="raloud-hint">Start the server with: supertonic serve --host 127.0.0.1 --port 7788</div>
      <label>Voice overrides (JSON, per language)</label>
      <textarea id="raloud-overrides" style="min-height:110px" spellcheck="false"></textarea>
      <div class="raloud-hint">Edge voices: {"de-DE":"de-DE-KatjaNeural"} · Supertonic styles: {"de-DE":"F2"} (F1–F5 / M1–M5)</div>
      <label>Pauses between sentences (Supertonic)</label>
      <div class="raloud-row" id="raloud-pausemodes"></div>
      <div class="raloud-row" style="margin-top:8px">
        <span style="font-weight:600">Pause multiplier</span>
        <input type="number" id="raloud-pausemult" min="0.5" max="1.5" step="0.1" style="width:90px" />
        <span class="raloud-hint" style="margin:0">× the added gap — A/B by ear (try 0.7 / 1 / 1.3)</span>
      </div>
      <div class="raloud-hint">Off = no added gaps · Compact = original, gap shrinks with speed (350 ms/√speed) · Research = boundary-restoring, gap grows with speed (~600/700/800/900 ms total at 1/1.5/2/2.5×). Sentence boundaries only; the model's own comma prosody is untouched.</div>
      <div class="raloud-row" style="margin-top:14px">
        <span style="flex:1"></span>
        <button id="raloud-conf-cancel" type="button">Cancel</button>
        <button id="raloud-conf-save" type="button" class="primary">Save</button>
      </div>
      <div class="err" id="raloud-conf-err"></div>
    </div>`;
  document.body.appendChild(conf);

  // ---- state + host message plumbing ---------------------------------------
  let st = await fetch('/api/state').then((r) => r.json()); // {settings, voiceUi, doc, supertonicOk, healthError}
  let engine = st.settings.engine;
  let docLocale = st.doc ? st.doc.locale : 'en-US';
  let hadAudio = false; // have we ever gotten audio this session (gates the Edge fallback)

  function dispatch(msg) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }
  window.__hostRoute = (m) => route(m).catch((err) => console.error('host route', err));

  async function postSettings(patch) {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || 'HTTP ' + res.status);
    const engineChanged = body.settings.engine !== engine;
    st = body;
    engine = body.settings.engine;
    if (body.healthError) showBanner('Supertonic: ' + body.healthError);
    else if (engineChanged) hideBanner();
    if (engineChanged) dispatch({ type: 'engineChanged', engine });
    dispatch({ type: 'voiceUi', ...body.voiceUi });
    return body;
  }

  function buildLoad(doc) {
    return {
      type: 'load',
      html: doc ? doc.html : '',
      title: doc ? doc.title : 'Read Aloud',
      docKey: '',
      baseHref: '',
      engine,
      rate: st.settings.rate,
      volume: st.settings.volume,
      settings: st.settings.readerSettings,
      prefs: st.settings.readerPrefs || null,
      resume: null,
      anchorText: null,
      autoplay: true,
      ...st.voiceUi,
    };
  }

  function showBanner(text, retryable) {
    banner.innerHTML = '';
    const span = document.createElement('div');
    span.textContent = text;
    banner.appendChild(span);
    if (retryable) {
      const retry = document.createElement('button');
      retry.textContent = 'Retry';
      retry.onclick = () => { hideBanner(); dispatch({ type: 'control', action: 'playpause' }); };
      banner.appendChild(retry);
    }
    const close = document.createElement('button');
    close.textContent = '×';
    close.onclick = hideBanner;
    banner.appendChild(close);
    banner.hidden = false;
  }
  const hideBanner = () => { banner.hidden = true; };

  // ---- reader → host --------------------------------------------------------

  async function doSynth(m) {
    if (engine === 'browser') return; // the reader synthesizes via speechSynthesis
    try {
      const res = await fetch('/api/synth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: m.text, docLocale }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'HTTP ' + res.status);
      }
      const bytes = await res.arrayBuffer();
      hadAudio = true;
      hideBanner();
      dispatch({
        type: 'audio',
        id: m.id,
        gen: m.gen,
        locale: res.headers.get('x-locale') || docLocale,
        mime: res.headers.get('content-type') || 'audio/wav',
        bytes,
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (engine === 'supertonic') {
        // Fail closed: pause, report, never substitute an online engine.
        dispatch({ type: 'control', action: 'pause' });
        dispatch({ type: 'audioError', id: m.id, gen: m.gen });
        showBanner('Read Aloud: the local Supertonic server is unavailable (' + msg + '). No document text was sent anywhere. Start it with "supertonic serve --host 127.0.0.1 --port 7788".', true);
      } else if (engine === 'edge' && !hadAudio) {
        engine = 'browser';
        dispatch({ type: 'engineFallback', engine: 'browser' });
        showBanner('Read Aloud: Edge voices unreachable (' + msg + '). Switched to system voices (offline).');
      } else {
        dispatch({ type: 'audioError', id: m.id, gen: m.gen });
      }
    }
  }

  async function route(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'synth':
        await doSynth(m);
        break;
      case 'setGender':
        await postSettings({ gender: m.gender === 'male' ? 'male' : 'female' }).catch((e) => showBanner(String(e.message || e)));
        break;
      case 'setAutoLang':
        await postSettings({ autoLang: !!m.value }).catch((e) => showBanner(String(e.message || e)));
        break;
      case 'setLocale':
        await postSettings({ locale: String(m.locale || st.voiceUi.locale), autoLang: false }).catch((e) => showBanner(String(e.message || e)));
        break;
      case 'setVoice': {
        // shortName is an Edge voice; adopt its locale and turn auto-language off.
        const v = (st.voiceUi.allVoices || []).find((x) => x.shortName === m.shortName);
        const patch = { autoLang: false };
        if (v) patch.locale = v.locale;
        await postSettings(patch).catch((e) => showBanner(String(e.message || e)));
        break;
      }
      case 'setTables':
        if (m.value === 'read' || m.value === 'skip') {
          const rs = { ...st.settings.readerSettings, tables: m.value };
          st.settings.readerSettings = rs;
          await postSettings({ readerSettings: rs }).catch(() => undefined);
        }
        break;
      case 'persistSpeed':
        if (Number.isFinite(Number(m.value))) await postSettings({ rate: Number(m.value) }).catch(() => undefined);
        break;
      case 'persistVolume':
        if (Number.isFinite(Number(m.value))) await postSettings({ volume: Number(m.value) }).catch(() => undefined);
        break;
      case 'persistPrefs':
        if (m.prefs && typeof m.prefs === 'object') await postSettings({ readerPrefs: m.prefs }).catch(() => undefined);
        break;
      case 'playState':
      case 'position':
        break; // nothing host-side to do (resume persists per session only)
      case 'openSource':
      case 'editSource':
        openEditor();
        break;
      case 'exportAudio':
        showBanner('Exporting audio files is not available in the web app.');
        break;
      case 'openSupport':
        window.open(KOFI_URL, '_blank', 'noopener');
        break;
      case 'noSystemVoice':
        showBanner('Read Aloud: no system voice for "' + String(m.lang || 'und') + '" is installed. Use Edge or Supertonic voices.');
        break;
      case 'ready':
        break; // app.js drives the initial load itself
    }
  }

  // ---- editor + settings modals --------------------------------------------
  let currentDocId = st.settings.currentDocId || null;
  let currentDocName = '';

  async function saveDoc(source) {
    const res = await fetch('/api/library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, id: currentDocId, name: $('raloud-name').value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message || 'HTTP ' + res.status);
    currentDocId = body.doc.id;
    currentDocName = body.doc.name;
    st.settings.currentDocId = currentDocId;
    st.settings.currentSource = source;
    renderRecent();
    return body.doc;
  }

  async function renderRecent() {
    const box = $('raloud-recent');
    try {
      const { docs } = await fetch('/api/library').then((r) => r.json());
      if (currentDocId && !currentDocName) {
        const mine = docs.find((d) => d.id === currentDocId);
        if (mine) {
          currentDocName = mine.name;
          if (!$('raloud-name').value) $('raloud-name').value = mine.name;
        }
      }
      if (!docs.length) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = '<h3>Documents</h3><ul>' +
        docs.map((d) => `
          <li>
            <span class="t" data-id="${d.id}" title="${d.name.replace(/"/g, '&quot;')}">${d.name}${d.id === currentDocId ? ' ●' : ''}</span>
            <span class="d">${new Date(d.openedAt).toLocaleDateString()}</span>
            <button class="x" data-del="${d.id}" title="Delete file">×</button>
          </li>`).join('') + '</ul>';
      box.querySelectorAll('.t').forEach((el) => (el.onclick = () => openById(el.dataset.id)));
      box.querySelectorAll('[data-del]').forEach((el) =>
        (el.onclick = async (e) => {
          e.stopPropagation();
          const res = await fetch('/api/library/' + el.dataset.del, { method: 'DELETE' });
          if (el.dataset.del === currentDocId) {
            currentDocId = null;
            currentDocName = '';
            $('raloud-name').value = '';
          }
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            showBanner(body.message || 'could not delete');
          }
          renderRecent();
        }));
    } catch {
      box.innerHTML = '';
    }
  }

  // ---- library manager ------------------------------------------------------
  const humanBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function renderManager() {
    const box = $('raloud-manage-list');
    try {
      const { docs } = await fetch('/api/library').then((r) => r.json());
      if (!docs.length) {
        box.innerHTML = '<p class="raloud-hint">No documents yet — paste markdown and Render & read, or Save.</p>';
        return;
      }
      box.innerHTML = '<table><thead><tr><th>Name</th><th>Modified</th><th>Size</th><th></th></tr></thead><tbody>' +
        docs.map((d) => `
          <tr data-id="${d.id}">
            <td class="nm" title="Click to open and read">${d.name.replace(/</g, '&lt;')}${d.id === currentDocId ? '<div class="cur">currently open</div>' : ''}</td>
            <td>${new Date(d.openedAt).toLocaleString()}</td>
            <td>${humanBytes(d.bytes || 0)}</td>
            <td class="ops">
              <a href="/api/library/file/${d.id}" download="${d.file.replace(/"/g, '')}"><button type="button" title="Download .md">↓</button></a>
              <button type="button" data-ren="${d.id}" data-name="${d.name.replace(/"/g, '&quot;')}" title="Rename">✎</button>
              <button type="button" data-del="${d.id}" title="Delete">×</button>
            </td>
          </tr>`).join('') + '</tbody></table>';

      box.querySelectorAll('.nm').forEach((el) =>
        (el.onclick = () => openById(el.parentElement.dataset.id)));
      box.querySelectorAll('[data-ren]').forEach((el) =>
        (el.onclick = () => {
          const td = el.closest('tr').querySelector('.nm');
          td.innerHTML = `<input value="${el.dataset.name.replace(/"/g, '&quot;')}" />`;
          const input = td.querySelector('input');
          input.focus();
          input.select();
          const commit = async () => {
            const name = input.value.trim();
            if (name && name !== el.dataset.name) {
              const res = await fetch('/api/library/rename', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: el.dataset.id, name }),
              });
              const body = await res.json();
              if (!res.ok) {
                $('raloud-manage-err').textContent = body.message || 'rename failed';
                return renderManager();
              }
              if (el.dataset.id === currentDocId) {
                currentDocName = body.doc.name;
                if (editor.hidden === false) $('raloud-name').value = body.doc.name;
              }
            }
            renderManager();
          };
          input.onkeydown = (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') renderManager();
          };
          input.onblur = commit;
        }));
      box.querySelectorAll('[data-del]').forEach((el) =>
        (el.onclick = async () => {
          const res = await fetch('/api/library/' + el.dataset.del, { method: 'DELETE' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            $('raloud-manage-err').textContent = body.message || 'delete failed';
          }
          if (el.dataset.del === currentDocId) {
            currentDocId = null;
            currentDocName = '';
            st.settings.currentDocId = null;
          }
          renderManager();
          renderRecent();
        }));
    } catch (err) {
      box.innerHTML = `<p class="raloud-hint">could not load library: ${String(err?.message || err)}</p>`;
    }
  }

  /** Fetch + open a library document, shared by the modal list and the manager. */
  async function openById(id) {
    const res = await fetch('/api/library/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const body = await res.json();
    if (!res.ok) return showBanner(body.message || 'could not open document');
    currentDocId = body.id;
    currentDocName = body.name;
    st.settings.currentDocId = body.id;
    st.settings.currentSource = body.source;
    docLocale = body.locale;
    $('raloud-name').value = body.name;
    $('raloud-src').value = body.source;
    manager.hidden = true;
    editor.hidden = true;
    hideBanner();
    dispatch(buildLoad(body));
  }

  $('raloud-manage').onclick = () => { editor.hidden = true; renderManager(); manager.hidden = false; };
  $('raloud-manage-close').onclick = () => { manager.hidden = true; openEditor(); };

  function openEditor() {
    $('raloud-name').value = currentDocName;
    $('raloud-src').value = st.settings.currentSource || '';
    $('raloud-err').textContent = '';
    $('raloud-err').className = 'err';
    renderRecent();
    editor.hidden = false;
    $('raloud-src').focus();
  }
  fab.onclick = openEditor;

  $('raloud-cancel').onclick = () => { editor.hidden = true; };
  $('raloud-clip').onclick = async () => {
    try {
      $('raloud-src').value = await navigator.clipboard.readText();
    } catch {
      $('raloud-err').textContent = 'Clipboard read blocked — paste into the box with Ctrl+V instead.';
    }
  };
  $('raloud-new').onclick = () => {
    currentDocId = null;
    currentDocName = '';
    st.settings.currentDocId = null;
    $('raloud-name').value = '';
    $('raloud-src').value = '';
    $('raloud-err').textContent = '';
    renderRecent();
    $('raloud-src').focus();
  };
  $('raloud-save').onclick = async () => {
    const source = $('raloud-src').value;
    if (!source.trim()) {
      $('raloud-err').textContent = 'Nothing to save yet — paste some markdown first.';
      return;
    }
    $('raloud-save').disabled = true;
    try {
      const doc = await saveDoc(source);
      $('raloud-err').className = 'raloud-ok';
      $('raloud-err').textContent = `Saved "${doc.name}" (${doc.file})`;
    } catch (err) {
      $('raloud-err').className = 'err';
      $('raloud-err').textContent = String(err?.message || err);
    } finally {
      $('raloud-save').disabled = false;
    }
  };
  $('raloud-go').onclick = async () => {
    const source = $('raloud-src').value;
    if (!source.trim()) {
      $('raloud-err').textContent = 'Nothing to read yet — paste some markdown first.';
      return;
    }
    $('raloud-go').disabled = true;
    try {
      const [rendered] = await Promise.all([
        fetch('/api/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }) }).then((r) => r.json().then((b) => ({ ok: r.ok, b }))),
        postSettings({ currentSource: source }).catch(() => undefined),
        // persist to the library under its name (in place when editing an open doc)
        saveDoc(source).catch(() => undefined),
      ]);
      if (!rendered.ok) throw new Error(rendered.b.message || 'render failed');
      docLocale = rendered.b.locale;
      hideBanner();
      editor.hidden = true;
      dispatch(buildLoad(rendered.b));
    } catch (err) {
      $('raloud-err').textContent = String(err?.message || err);
    } finally {
      $('raloud-go').disabled = false;
    }
  };

  function openSettings() {
    const engines = [['supertonic', 'Supertonic (local server)'], ['edge', 'Edge voices (online — sends text to Microsoft)'], ['browser', 'System voices (offline)']];
    $('raloud-engines').innerHTML = engines
      .map(([v, label]) => `<label style="font-weight:400;display:flex;gap:6px;align-items:center;margin:2px 0"><input type="radio" name="raloud-engine" value="${v}" ${engine === v ? 'checked' : ''}/>${label}</label>`)
      .join('');
    $('raloud-endpoint').value = st.settings.supertonicEndpoint;
    $('raloud-overrides').value = JSON.stringify(st.settings.voiceOverrides || {}, null, 2);
    const modes = [['off', 'Off'], ['compact', 'Compact (original)'], ['research', 'Research']];
    $('raloud-pausemodes').innerHTML = modes
      .map(([v, label]) => `<label style="font-weight:400;display:flex;gap:6px;align-items:center;margin:2px 0"><input type="radio" name="raloud-pausemode" value="${v}" ${(st.settings.pauseMode || 'off') === v ? 'checked' : ''}/>${label}</label>`)
      .join('');
    $('raloud-pausemult').value = st.settings.pauseMultiplier ?? 1;
    $('raloud-conf-err').textContent = '';
    conf.hidden = false;
  }
  fab.oncontextmenu = (e) => { e.preventDefault(); openSettings(); };
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) { e.preventDefault(); openEditor(); }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  $('raloud-conf-cancel').onclick = () => { conf.hidden = true; };
  $('raloud-conf-save').onclick = async () => {
    let overrides = {};
    try {
      overrides = JSON.parse($('raloud-overrides').value || '{}');
    } catch {
      $('raloud-conf-err').textContent = 'Voice overrides is not valid JSON.';
      return;
    }
    const patch = {
      engine: (conf.querySelector('input[name=raloud-engine]:checked') || {}).value,
      supertonicEndpoint: $('raloud-endpoint').value.trim(),
      voiceOverrides: overrides,
      pauseMode: (conf.querySelector('input[name=raloud-pausemode]:checked') || {}).value || 'off',
      pauseMultiplier: Number($('raloud-pausemult').value) || 1,
    };
    $('raloud-conf-save').disabled = true;
    try {
      await postSettings(patch);
      conf.hidden = true;
    } catch (err) {
      $('raloud-conf-err').textContent = String(err?.message || err);
    } finally {
      $('raloud-conf-save').disabled = false;
    }
  };

  // ---- boot -----------------------------------------------------------------
  if (st.healthError) {
    showBanner('Read Aloud: the local Supertonic server is unavailable (' + st.healthError + '). No document text was sent anywhere. Start it with "supertonic serve --host 127.0.0.1 --port 7788", or right-click the paste button → App settings to change the engine.', true);
  }
  dispatch(buildLoad(st.doc));
  if (!st.doc) openEditor();
})();
