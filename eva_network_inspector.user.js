// ==UserScript==
// @name         EVA — Inspecteur réseau (diagnostic)
// @namespace    eva-network-inspector
// @version      1.0
// @description  Capture TOUTES les requêtes réseau JSON/GraphQL du site EVA, pour retrouver la structure des données après un changement de format. Script de diagnostic ponctuel, pas destiné à tourner en continu.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// COMMENT S'EN SERVIR
// 1. Installe ce script dans Tampermonkey (nouveau script, colle tout ce fichier, sauvegarde).
//    Tu peux le laisser actif EN MÊME TEMPS que eva_history_collector.user.js, ils ne se
//    gênent pas — désactive juste ce script-ci une fois le diagnostic terminé (il capture
//    beaucoup plus de choses que le collecteur normal, pas la peine de le garder actif).
// 2. Va sur le site EVA. Un panneau "Inspecteur réseau" apparaît en bas à gauche.
// 3. Recharge/consulte ta page de profil (et toute autre page qui te semble concernée).
//    Clique "📍 Repère" juste avant de le faire, pour marquer dans le journal l'endroit
//    exact où commence ce qui t'intéresse — ça aide énormément à s'y retrouver ensuite.
// 4. Clique "Copier tout (JSON)" ou "Télécharger JSON", et envoie-moi le résultat
//    (colle-le dans le chat, ou upload le fichier téléchargé) — je m'en sers pour retrouver
//    la nouvelle structure des données et mettre à jour le collecteur/la visionneuse en
//    conséquence.
//
// Contrairement au collecteur normal (qui ne garde que 2 types de requêtes bien précis),
// celui-ci capture TOUT ce qui ressemble à une réponse API (JSON, GraphQL) sans présupposer
// aucun nom de champ — indispensable puisque c'est justement le format qui a changé.

(function () {
  'use strict';

  const HOST_HINT = 'eva';
  if (!location.hostname.toLowerCase().includes(HOST_HINT)) return;

  const MAX_ENTRIES = 150;       // on garde un historique glissant, pas un log illimité
  const MAX_BODY_CHARS = 200000; // évite qu'une seule très grosse réponse fasse exploser l'export

  let entries = [];
  let seq = 0;
  let paused = false;
  let filterText = '';
  let panelCollapsed = false;

  // ---------------------------------------------------------------------------
  // Détection : on capture large plutôt que de filtrer par nom de champ connu,
  // puisque c'est justement ça qui a changé côté EVA.
  // ---------------------------------------------------------------------------
  function looksInteresting(url, reqBody, resText) {
    if (!resText) return false;
    const u = (url || '').toLowerCase();
    if (u.includes('graphql') || u.includes('/api')) return true;
    if (reqBody && /"query"|"operationName"|mutation\s|query\s/i.test(reqBody)) return true;
    const trimmed = resText.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
    return false;
  }

  function truncate(s) {
    if (!s) return s;
    if (s.length > MAX_BODY_CHARS) {
      return s.slice(0, MAX_BODY_CHARS) + `\n…[tronqué ici, ${s.length} caractères au total]`;
    }
    return s;
  }

  function prettyOrRaw(text) {
    if (!text) return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return text;
    }
  }

  function guessOperationName(reqBody) {
    if (!reqBody) return null;
    try {
      const parsed = JSON.parse(reqBody);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!obj) return null;
      if (obj.operationName) return obj.operationName;
      const m = typeof obj.query === 'string' && obj.query.match(/(?:query|mutation)\s+(\w+)/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  function shortUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.pathname + u.search;
    } catch (e) {
      return url;
    }
  }

  function addEntry(entry) {
    entry.id = ++seq;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    renderList();
  }

  function addMarker() {
    addEntry({ id: ++seq, marker: true, time: new Date().toLocaleTimeString('fr-FR') });
  }

  // ---------------------------------------------------------------------------
  // Hooks réseau — mêmes principes que le collecteur normal, mais sans filtre
  // sur des noms de requêtes précis.
  // ---------------------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const init = args[1] || {};
    const reqBody = typeof init.body === 'string' ? init.body : null;
    return origFetch.apply(this, args).then(res => {
      if (!paused) {
        try {
          res.clone().text().then(text => {
            if (looksInteresting(url, reqBody, text)) {
              addEntry({
                time: new Date().toLocaleTimeString('fr-FR'),
                kind: 'fetch',
                method: (init.method || 'GET').toUpperCase(),
                url, status: res.status,
                operationName: guessOperationName(reqBody),
                requestBody: truncate(reqBody),
                responseBody: truncate(text),
              });
            }
          }).catch(() => {});
        } catch (e) {}
      }
      return res;
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__eva_method = method;
    this.__eva_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('loadend', function () {
      if (paused) return;
      try {
        const text = this.responseText;
        if (looksInteresting(this.__eva_url || '', body, text)) {
          addEntry({
            time: new Date().toLocaleTimeString('fr-FR'),
            kind: 'xhr',
            method: (this.__eva_method || 'GET').toUpperCase(),
            url: this.__eva_url, status: this.status,
            operationName: guessOperationName(body),
            requestBody: truncate(typeof body === 'string' ? body : null),
            responseBody: truncate(text),
          });
        }
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Panneau flottant
  // ---------------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #eva-inspector { position:fixed; bottom:16px; left:16px; z-index:2147483647;
      width:420px; max-height:70vh; background:#0d1017; border:1px solid #262c3a;
      border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,.5); font-family:-apple-system,'Segoe UI',Roboto,sans-serif;
      color:#e7ebf3; display:flex; flex-direction:column; overflow:hidden; }
    #eva-inspector.collapsed { max-height:auto; }
    #eva-inspector.collapsed #eva-insp-body { display:none; }
    #eva-insp-head { display:flex; align-items:center; gap:8px; padding:10px 12px;
      background:#151a24; border-bottom:1px solid #262c3a; cursor:pointer; user-select:none; }
    #eva-insp-head b { font-size:13px; }
    #eva-insp-count { font-size:11px; color:#7c8598; margin-left:auto; }
    #eva-insp-body { display:flex; flex-direction:column; min-height:0; flex:1; }
    #eva-insp-controls { display:flex; flex-wrap:wrap; gap:6px; padding:8px 10px; border-bottom:1px solid #262c3a; }
    #eva-insp-controls input[type=text] { flex:1; min-width:100px; background:#161b28; border:1px solid #262c3a;
      border-radius:6px; color:#e7ebf3; padding:5px 8px; font-size:12px; }
    #eva-insp-controls button { background:#161b28; border:1px solid #262c3a; color:#e7ebf3;
      border-radius:6px; padding:5px 9px; font-size:11px; cursor:pointer; }
    #eva-insp-controls button:hover { background:#1c2230; }
    #eva-insp-controls button.primary { background:#4f9dff; border-color:#4f9dff; color:#0a0d14; font-weight:700; }
    #eva-insp-list { overflow-y:auto; flex:1; padding:6px; }
    .eva-insp-row { border:1px solid #232a3a; border-radius:8px; margin-bottom:6px; overflow:hidden; }
    .eva-insp-row-head { display:flex; align-items:center; gap:6px; padding:7px 9px; cursor:pointer; font-size:11px; }
    .eva-insp-row-head:hover { background:#161b28; }
    .eva-insp-method { font-family:ui-monospace,Menlo,Consolas,monospace; font-weight:700; color:#4f9dff; }
    .eva-insp-op { font-weight:600; }
    .eva-insp-url { color:#7c8598; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
    .eva-insp-status { font-family:ui-monospace,Menlo,Consolas,monospace; color:#7c8598; }
    .eva-insp-status.err { color:#ff5c69; }
    .eva-insp-detail { display:none; padding:8px 10px; border-top:1px solid #232a3a; background:#0a0d14; }
    .eva-insp-detail.open { display:block; }
    .eva-insp-detail h4 { margin:0 0 4px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:#7c8598; }
    .eva-insp-detail pre { background:#11151f; border:1px solid #232a3a; border-radius:6px; padding:8px;
      font-size:10px; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-all; margin:0 0 8px; }
    .eva-insp-detail button { margin-bottom:8px; }
    .eva-insp-marker { background:#2a2210; border:1px solid #ffc857; border-radius:8px; padding:6px 9px;
      margin-bottom:6px; font-size:11px; color:#ffc857; font-weight:700; text-align:center; }
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'eva-inspector';
  panel.innerHTML = `
    <div id="eva-insp-head">
      <b>🔍 Inspecteur réseau</b>
      <span id="eva-insp-count">0 capturée(s)</span>
    </div>
    <div id="eva-insp-body">
      <div id="eva-insp-controls">
        <input type="text" id="eva-insp-filter" placeholder="Filtrer (url, nom d'opération...)">
        <button id="eva-insp-marker-btn">📍 Repère</button>
        <button id="eva-insp-pause-btn">⏸ Pause</button>
        <button id="eva-insp-clear-btn">🗑 Vider</button>
        <button id="eva-insp-copy-btn" class="primary">Copier tout (JSON)</button>
        <button id="eva-insp-dl-btn">Télécharger JSON</button>
      </div>
      <div id="eva-insp-list"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  document.getElementById('eva-insp-head').addEventListener('click', () => {
    panelCollapsed = !panelCollapsed;
    panel.classList.toggle('collapsed', panelCollapsed);
  });
  document.getElementById('eva-insp-filter').addEventListener('input', (e) => {
    filterText = e.target.value.toLowerCase();
    renderList();
  });
  document.getElementById('eva-insp-marker-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    addMarker();
  });
  document.getElementById('eva-insp-pause-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    paused = !paused;
    e.target.textContent = paused ? '▶ Reprendre' : '⏸ Pause';
  });
  document.getElementById('eva-insp-clear-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    entries = [];
    renderList();
  });
  document.getElementById('eva-insp-copy-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const json = JSON.stringify(entries, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      flashButton(e.target, 'Copié ✓');
    } catch (err) {
      // fallback si le clipboard API est bloqué (contexte non sécurisé, permissions...)
      const ta = document.createElement('textarea');
      ta.value = json; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      flashButton(e.target, 'Copié ✓');
    }
  });
  document.getElementById('eva-insp-dl-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const json = JSON.stringify(entries, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eva-network-inspect-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  function flashButton(btn, text) {
    const original = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = original; }, 1200);
  }

  function matchesFilter(entry) {
    if (!filterText) return true;
    if (entry.marker) return true;
    const haystack = `${entry.url || ''} ${entry.operationName || ''} ${entry.method || ''}`.toLowerCase();
    return haystack.includes(filterText);
  }

  function renderList() {
    document.getElementById('eva-insp-count').textContent = `${entries.length} capturée(s)`;
    const list = document.getElementById('eva-insp-list');
    const visible = entries.filter(matchesFilter).slice().reverse();
    list.innerHTML = visible.map(entry => {
      if (entry.marker) {
        return `<div class="eva-insp-marker">📍 Repère — ${entry.time}</div>`;
      }
      const statusClass = entry.status >= 400 ? 'err' : '';
      const op = entry.operationName ? `<span class="eva-insp-op">${entry.operationName}</span>` : '';
      return `
        <div class="eva-insp-row" data-id="${entry.id}">
          <div class="eva-insp-row-head" data-toggle="${entry.id}">
            <span class="eva-insp-method">${entry.method}</span>
            ${op}
            <span class="eva-insp-url">${shortUrl(entry.url)}</span>
            <span class="eva-insp-status ${statusClass}">${entry.status ?? ''}</span>
          </div>
          <div class="eva-insp-detail" id="eva-insp-detail-${entry.id}">
            ${entry.requestBody ? `
              <h4>Requête</h4>
              <pre>${escapeHtml(prettyOrRaw(entry.requestBody))}</pre>
            ` : ''}
            <h4>Réponse (${entry.time})</h4>
            <pre>${escapeHtml(prettyOrRaw(entry.responseBody))}</pre>
            <button data-copy="${entry.id}">Copier cette entrée</button>
          </div>
        </div>`;
    }).join('') || '<div style="color:#7c8598;font-size:12px;padding:10px;text-align:center;">Rien capturé pour l\'instant — navigue sur le site.</div>';

    list.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.toggle;
        document.getElementById(`eva-insp-detail-${id}`).classList.toggle('open');
      });
    });
    list.querySelectorAll('[data-copy]').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = Number(el.dataset.copy);
        const entry = entries.find(x => x.id === id);
        const json = JSON.stringify(entry, null, 2);
        try {
          await navigator.clipboard.writeText(json);
          flashButton(el, 'Copié ✓');
        } catch (err) {
          const ta = document.createElement('textarea');
          ta.value = json; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          flashButton(el, 'Copié ✓');
        }
      });
    });
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  renderList();
})();
