/* ============================================================================
   iDesign Site Review — commenting overlay
   Injected into the LIVE site via bookmarklet (runs same-origin, no iframe,
   so it is not affected by Webflow's frame-ancestors CSP).

   Config is passed by the bookmarklet via window.IDR_CONFIG BEFORE this loads:
     window.IDR_CONFIG = { url, key, project }
   - url/key present  -> shared storage via Supabase REST
   - url/key absent   -> local-only mode (this browser only), for quick demos
   ========================================================================== */
(function () {
  'use strict';

  // ---- guard against double injection --------------------------------------
  if (window.__idrLoaded) { try { window.__idrToggle && window.__idrToggle(); } catch (e) {} return; }
  window.__idrLoaded = true;

  var CFG = window.IDR_CONFIG || {};
  // Universal: if no project is set, auto-scope to the site's domain so each
  // site's feedback stays separate. Mirror pages still pass an explicit project.
  var PROJECT = CFG.project || location.hostname || 'idesign-review';
  var SB = (CFG.url && CFG.key) ? { url: CFG.url.replace(/\/+$/, ''), key: CFG.key } : null;
  var PAGE = CFG.page || location.pathname || '/';   // mirror pages pass the real path via CFG.page

  // ---- tiny helpers --------------------------------------------------------
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'style') n.style.cssText = props[k];
      else if (k === 'html') n.innerHTML = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function uuid() { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
  function timeAgo(iso) {
    var s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    var m = s / 60; if (m < 60) return Math.floor(m) + 'm ago';
    var h = m / 60; if (h < 24) return Math.floor(h) + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // ---- identity ------------------------------------------------------------
  function getEmail() { try { return localStorage.getItem('idr_email') || ''; } catch (e) { return ''; } }
  function setEmail(v) { try { localStorage.setItem('idr_email', v); } catch (e) {} }
  function getName() { try { return localStorage.getItem('idr_name') || ''; } catch (e) { return ''; } }
  function setName(v) { try { localStorage.setItem('idr_name', v); } catch (e) {} }
  // What gets stored/shown as the comment author: "Name (email)" when a name exists.
  function getAuthor() { var n = getName(), e = getEmail(); return n ? (e ? n + ' (' + e + ')' : n) : e; }

  // ---- storage backends ----------------------------------------------------
  var Store = SB ? supabaseStore() : localStore();

  function localStore() {
    var KEY = 'idr_comments_' + PROJECT;
    function all() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
    function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
    return {
      mode: 'local',
      list: function () { return Promise.resolve(all().filter(function (c) { return c.project === PROJECT; })); },
      add: function (c) { var a = all(); c.id = uuid(); c.created_at = new Date().toISOString(); a.push(c); save(a); return Promise.resolve(c); },
      update: function (id, patch) { var a = all(); a.forEach(function (c) { if (c.id === id) Object.assign(c, patch); }); save(a); return Promise.resolve(); },
      remove: function (id) { save(all().filter(function (c) { return c.id !== id && c.parent_id !== id; })); return Promise.resolve(); }
    };
  }

  // A pristine fetch, immune to page-level monkeypatching. Some sites (Webflow /
  // Finsweet / analytics) wrap window.fetch and inject headers with non-Latin-1
  // characters, which throws when the overlay makes cross-origin calls. An iframe
  // gets its own untouched realm, so its fetch is clean.
  var xfetch = (function () {
    try {
      var f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'display:none!important;width:0;height:0;border:0';
      (document.body || document.documentElement).appendChild(f);
      var cf = f.contentWindow && f.contentWindow.fetch;
      if (cf) return cf.bind(f.contentWindow);
    } catch (e) {}
    return window.fetch.bind(window);
  })();

  function supabaseStore() {
    var base = SB.url + '/rest/v1/review_comments';
    var H = { 'apikey': SB.key, 'Authorization': 'Bearer ' + SB.key, 'Content-Type': 'application/json' };
    return {
      mode: 'shared',
      list: function () {
        return xfetch(base + '?project=eq.' + encodeURIComponent(PROJECT) + '&select=*&order=created_at.asc', { headers: H })
          .then(function (r) { if (!r.ok) throw new Error('list ' + r.status); return r.json(); });
      },
      add: function (c) {
        return xfetch(base, { method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, H), body: JSON.stringify([c]) })
          .then(function (r) { if (!r.ok) throw new Error('add ' + r.status); return r.json(); })
          .then(function (rows) { return rows[0]; });
      },
      update: function (id, patch) {
        return xfetch(base + '?id=eq.' + id, { method: 'PATCH', headers: H, body: JSON.stringify(patch) })
          .then(function (r) { if (!r.ok) throw new Error('update ' + r.status); });
      },
      remove: function (id) {
        return xfetch(base + '?id=eq.' + id, { method: 'DELETE', headers: H })
          .then(function () { return xfetch(base + '?parent_id=eq.' + id, { method: 'DELETE', headers: H }); });
      }
    };
  }

  // ---- anchoring (which element/point a comment belongs to) -----------------
  function cssPath(node) {
    if (!node || node.nodeType !== 1) return '';
    var parts = [];
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 12) {
      var tag = node.tagName.toLowerCase();
      var parent = node.parentNode;
      if (parent) {
        var same = [].filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) tag += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(tag);
      node = node.parentNode;
    }
    return 'body>' + parts.join('>');
  }
  function makeAnchor(target, clientX, clientY) {
    var r = target.getBoundingClientRect();
    var relX = r.width ? (clientX - r.left) / r.width : 0.5;
    var relY = r.height ? (clientY - r.top) / r.height : 0.5;
    var docW = document.documentElement.scrollWidth || 1;
    var docH = document.documentElement.scrollHeight || 1;
    return {
      sel: cssPath(target),
      relX: Math.max(0, Math.min(1, relX)),
      relY: Math.max(0, Math.min(1, relY)),
      tx: (target.textContent || '').trim().slice(0, 80),
      fpx: (clientX + window.scrollX) / docW,   // fraction of full document (fallback)
      fpy: (clientY + window.scrollY) / docH
    };
  }
  // returns viewport {x,y} for a comment's anchor, or null if off-viewport but resolvable
  function resolveAnchor(a) {
    if (!a) return null;
    var node = null;
    try { node = a.sel && document.querySelector(a.sel); } catch (e) {}
    if (!node && a.tx) {
      // fallback: find an element containing the snippet text
      var walker = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,a,span,li,button,div,img,strong,em');
      for (var i = 0; i < walker.length; i++) {
        if ((walker[i].textContent || '').trim().indexOf(a.tx) === 0) { node = walker[i]; break; }
      }
    }
    if (node) {
      var r = node.getBoundingClientRect();
      return { x: r.left + a.relX * r.width, y: r.top + a.relY * r.height, ok: true };
    }
    // last resort: full-document fraction
    var docW = document.documentElement.scrollWidth || 1;
    var docH = document.documentElement.scrollHeight || 1;
    return { x: a.fpx * docW - window.scrollX, y: a.fpy * docH - window.scrollY, ok: false };
  }

  // ---- UI root (shadow DOM keeps the site's CSS from touching us) -----------
  var host = el('div', { id: 'idr-host', style: 'all:initial;position:fixed;inset:0;z-index:2147483000;pointer-events:none;' });
  document.documentElement.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.appendChild(el('style', { text: STYLES() }));

  var pinLayer = el('div', { class: 'idr-pins' });
  var captureLayer = el('div', { class: 'idr-capture', style: 'display:none' });
  var panel = el('div', { class: 'idr-panel' });
  var popHost = el('div', { class: 'idr-pop-host' });
  var scrim = el('div', { class: 'idr-scrim', style: 'display:none' });
  root.appendChild(pinLayer);
  root.appendChild(captureLayer);
  root.appendChild(panel);
  root.appendChild(popHost);
  root.appendChild(scrim);

  var state = { comments: [], mode: false, filter: 'open', openPop: null, open: true };

  // ---- panel (control bar + comment list) ----------------------------------
  function renderPanel() {
    var parents = topLevel();
    var mine = parents.filter(function (c) { return c.author === getAuthor(); }).length;
    var openN = parents.filter(function (c) { return !c.resolved; }).length;
    panel.innerHTML = '';
    if (!state.open) {
      panel.className = 'idr-panel idr-collapsed';
      panel.appendChild(el('button', { class: 'idr-fab', title: 'Open Site Reviewer', text: 'Site Reviewer · ' + openN, onclick: function () { state.open = true; renderPanel(); } }));
      return;
    }
    panel.className = 'idr-panel';
    var head = el('div', { class: 'idr-head' }, [
      el('div', { class: 'idr-brand' }, [ el('span', { class: 'idr-dot' }), el('strong', { text: "Creative + Marketing Site Reviewer | iDesign" }) ]),
      el('button', { class: 'idr-x', text: '–', title: 'Minimize', onclick: function () { state.open = false; renderPanel(); } })
    ]);
    var who = el('div', { class: 'idr-who' }, [
      el('span', { class: 'idr-whoname', text: getAuthor() || 'not signed in' }),
      el('span', { class: 'idr-wholinks' }, [
        el('button', { class: 'idr-link', text: getEmail() ? 'change' : 'sign in', onclick: askEmail }),
        getEmail() ? el('button', { class: 'idr-link', text: 'sign out', onclick: signOut }) : null
      ])
    ]);
    var addBtn = el('button', {
      class: 'idr-add' + (state.mode ? ' on' : ''),
      text: state.mode ? '✕  Cancel — comment mode is on' : '+  Add comment',
      onclick: function () { if (!getEmail()) { askEmail(); return; } setMode(!state.mode); }
    });
    var tabs = el('div', { class: 'idr-tabs' }, ['open', 'all', 'resolved', 'mine'].map(function (f) {
      return el('button', { class: 'idr-tab' + (state.filter === f ? ' on' : ''), text: f + (f === 'mine' ? ' (' + mine + ')' : f === 'open' ? ' (' + openN + ')' : ''), onclick: function () { state.filter = f; renderPanel(); schedulePins(); } });
    }));
    var list = el('div', { class: 'idr-list' });
    var shown = filtered();
    if (!shown.length) list.appendChild(el('div', { class: 'idr-empty', text: state.mode ? 'Now click anywhere on the page to drop a comment.' : 'No comments yet. Hit “Add comment”, then click any element or text.' }));
    shown.forEach(function (c) {
      var n = numberOf(c);
      var reps = repliesOf(c.id).length;
      var row = el('div', { class: 'idr-item' + (c.resolved ? ' done' : ''), onclick: function () { scrollToPin(c); openThread(c); } }, [
        el('span', { class: 'idr-badge' + (c.resolved ? ' done' : ''), text: c.resolved ? '✓' : String(n) }),
        el('div', { class: 'idr-item-body' }, [
          el('div', { class: 'idr-item-top' }, [ el('span', { class: 'idr-au', text: c.author }), el('span', { class: 'idr-ago', text: timeAgo(c.created_at) }) ]),
          el('div', { class: 'idr-item-txt', text: c.body }),
          reps ? el('div', { class: 'idr-item-reps', text: reps + ' repl' + (reps > 1 ? 'ies' : 'y') }) : null
        ])
      ]);
      list.appendChild(row);
    });
    var foot = el('div', { class: 'idr-foot' }, [
      el('span', { text: (Store.mode === 'shared' ? '● shared' : '○ local only') + ' · ' + parents.length + ' comments' }),
      el('button', { class: 'idr-link', text: 'refresh', onclick: refresh })
    ]);
    [head, who, addBtn, tabs, list, foot].forEach(function (x) { panel.appendChild(x); });
  }

  function filtered() {
    var p = topLevel();
    if (state.filter === 'open') return p.filter(function (c) { return !c.resolved; });
    if (state.filter === 'resolved') return p.filter(function (c) { return c.resolved; });
    if (state.filter === 'mine') return p.filter(function (c) { return c.author === getAuthor(); });
    return p;
  }
  function topLevel() { return state.comments.filter(function (c) { return c.page === PAGE && !c.parent_id; }).sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); }); }
  function repliesOf(id) { return state.comments.filter(function (c) { return c.parent_id === id; }).sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); }); }
  function numberOf(c) { return topLevel().indexOf(c) + 1; }

  // ---- comment mode + click capture ----------------------------------------
  function setMode(on) {
    state.mode = on;
    captureLayer.style.display = on ? 'block' : 'none';
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    renderPanel();
  }
  captureLayer.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    captureLayer.style.pointerEvents = 'none';
    var target = document.elementFromPoint(e.clientX, e.clientY) || document.body;
    captureLayer.style.pointerEvents = '';
    var anchor = makeAnchor(target, e.clientX, e.clientY);
    setMode(false);
    newCommentPop(anchor, e.clientX, e.clientY);
  });

  // ---- popovers (new comment + thread) -------------------------------------
  function clearPop() { popHost.innerHTML = ''; state.openPop = null; }
  function placePop(box, x, y) {
    popHost.appendChild(box);
    var w = 320, vw = window.innerWidth, vh = window.innerHeight;
    var left = Math.min(Math.max(12, x - w / 2), vw - w - 12);
    var top = Math.min(Math.max(12, y + 14), vh - box.offsetHeight - 12);
    box.style.left = left + 'px'; box.style.top = top + 'px';
  }
  function newCommentPop(anchor, x, y) {
    clearPop();
    var ta = el('textarea', { class: 'idr-ta', placeholder: 'What needs to change here?' });
    var box = el('div', { class: 'idr-pop' }, [
      el('div', { class: 'idr-pop-h', text: 'New comment' }),
      ta,
      el('div', { class: 'idr-pop-a' }, [
        el('button', { class: 'idr-btn ghost', text: 'Cancel', onclick: clearPop }),
        el('button', { class: 'idr-btn', text: 'Post', onclick: function () {
          var body = ta.value.trim(); if (!body) { ta.focus(); return; }
          Store.add({ project: PROJECT, page: PAGE, author: getAuthor(), body: body, anchor: anchor, parent_id: null, resolved: false })
            .then(function () { clearPop(); refresh(); }).catch(err);
        } })
      ])
    ]);
    placePop(box, x, y); ta.focus();
    state.openPop = { anchor: anchor };
  }
  function openThread(c) {
    var pos = resolveAnchor(c.anchor) || { x: window.innerWidth / 2, y: 120 };
    clearPop();
    var wrap = el('div', { class: 'idr-thread' });
    function line(item, isReply) {
      return el('div', { class: 'idr-msg' + (isReply ? ' reply' : '') }, [
        el('div', { class: 'idr-msg-top' }, [ el('span', { class: 'idr-au', text: item.author }), el('span', { class: 'idr-ago', text: timeAgo(item.created_at) }) ]),
        el('div', { class: 'idr-msg-txt', text: item.body }),
        item.author === getAuthor() ? el('button', { class: 'idr-trash', title: 'Delete', text: '🗑', onclick: function () { Store.remove(item.id).then(function () { clearPop(); refresh(); }).catch(err); } }) : null
      ]);
    }
    wrap.appendChild(line(c, false));
    repliesOf(c.id).forEach(function (r) { wrap.appendChild(line(r, true)); });
    var ta = el('textarea', { class: 'idr-ta', placeholder: 'Reply…' });
    var box = el('div', { class: 'idr-pop wide' }, [
      el('div', { class: 'idr-pop-h' }, [
        el('span', { text: 'Comment #' + numberOf(c) }),
        el('button', { class: 'idr-link', text: c.resolved ? 'reopen' : 'resolve', onclick: function () { Store.update(c.id, { resolved: !c.resolved }).then(refresh).then(clearPop).catch(err); } }),
        el('button', { class: 'idr-x', text: '×', onclick: clearPop })
      ]),
      wrap, ta,
      el('div', { class: 'idr-pop-a' }, [
        el('button', { class: 'idr-btn', text: 'Reply', onclick: function () {
          var body = ta.value.trim(); if (!body) { if (!getEmail()) askEmail(); ta.focus(); return; }
          if (!getEmail()) { askEmail(); return; }
          Store.add({ project: PROJECT, page: PAGE, author: getAuthor(), body: body, anchor: null, parent_id: c.id, resolved: false })
            .then(function () { refresh().then(function () { openThread(c); }); }).catch(err);
        } })
      ])
    ]);
    placePop(box, pos.x, pos.y);
  }

  // ---- pins ----------------------------------------------------------------
  var rafPending = false;
  function positionPins() {
    rafPending = false;
    pinLayer.innerHTML = '';
    var vw = window.innerWidth, vh = window.innerHeight;
    filtered().forEach(function (c) {
      var pos = resolveAnchor(c.anchor); if (!pos) return;
      var onScreen = pos.x > -30 && pos.x < vw + 30 && pos.y > -30 && pos.y < vh + 30;
      var pin = el('button', {
        class: 'idr-pin' + (c.resolved ? ' done' : '') + (onScreen ? '' : ' off'),
        text: c.resolved ? '✓' : String(numberOf(c)),
        title: c.author + ': ' + c.body,
        onclick: function (ev) { ev.stopPropagation(); openThread(c); }
      });
      var px = Math.max(6, Math.min(vw - 6, pos.x));
      var py = Math.max(6, Math.min(vh - 6, pos.y));
      pin.style.left = px + 'px'; pin.style.top = py + 'px';
      pinLayer.appendChild(pin);
    });
  }
  function schedulePins() { if (!rafPending) { rafPending = true; requestAnimationFrame(positionPins); } }
  function scrollToPin(c) {
    var node = null; try { node = c.anchor && c.anchor.sel && document.querySelector(c.anchor.sel); } catch (e) {}
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (c.anchor) window.scrollTo({ top: c.anchor.fpy * document.documentElement.scrollHeight - window.innerHeight / 2, behavior: 'smooth' });
    setTimeout(schedulePins, 400);
  }
  window.addEventListener('scroll', schedulePins, { passive: true });
  window.addEventListener('resize', schedulePins);

  // ---- sign out (clears identity and re-shows the gate) --------------------
  function signOut() {
    try { localStorage.removeItem('idr_name'); localStorage.removeItem('idr_email'); } catch (e) {}
    setMode(false); clearPop(); renderPanel(); emailGate();
  }

  // ---- email gate (dims the page until the reviewer signs in) --------------
  function emailGate() {
    clearPop();
    scrim.innerHTML = '';
    var nameInp = el('input', { class: 'idr-input', type: 'text', placeholder: 'Your name', value: getName() });
    var inp = el('input', { class: 'idr-input', type: 'email', placeholder: 'you@idesignedu.org', value: getEmail() });
    var save = el('button', { class: 'idr-btn', text: 'Start reviewing', onclick: function () {
      var nm = nameInp.value.trim(); var v = inp.value.trim();
      if (!nm) { nameInp.focus(); return; }
      if (!/.+@.+\..+/.test(v)) { inp.focus(); return; }
      setName(nm); setEmail(v); scrim.style.display = 'none'; scrim.innerHTML = ''; renderPanel(); schedulePins();
    } });
    var box = el('div', { class: 'idr-gate' }, [
      el('div', { class: 'idr-gate-brand' }, [ el('span', { class: 'idr-dot' }), el('strong', { text: "Creative + Marketing Site Reviewer | iDesign" }) ]),
      el('div', { class: 'idr-gate-h', text: 'Sign in to review' }),
      el('div', { class: 'idr-note', text: 'So the team knows who left each comment. Then click any element or text on the page to leave a note.' }),
      nameInp,
      inp,
      el('div', { class: 'idr-pop-a' }, [ save ])
    ]);
    function onKey(e) { if (e.key === 'Enter') save.click(); }
    nameInp.addEventListener('keydown', onKey); inp.addEventListener('keydown', onKey);
    scrim.appendChild(box);
    scrim.style.display = 'flex';
    setTimeout(function () { inp.focus(); }, 30);
  }

  // ---- identity prompt (dismissible, for changing name/email later) --------
  function askEmail() {
    clearPop();
    var nameInp = el('input', { class: 'idr-input', type: 'text', placeholder: 'Your name', value: getName() });
    var inp = el('input', { class: 'idr-input', type: 'email', placeholder: 'you@idesignedu.org', value: getEmail() });
    inp.style.marginTop = '8px';
    var box = el('div', { class: 'idr-pop center' }, [
      el('div', { class: 'idr-pop-h', text: 'Who are you?' }),
      el('div', { class: 'idr-note', text: 'So the team knows who left each comment.' }),
      nameInp, inp,
      el('div', { class: 'idr-pop-a' }, [
        el('button', { class: 'idr-btn', text: 'Save', onclick: function () {
          var nm = nameInp.value.trim(); var v = inp.value.trim();
          if (!nm) { nameInp.focus(); return; }
          if (!/.+@.+\..+/.test(v)) { inp.focus(); return; }
          setName(nm); setEmail(v); clearPop(); renderPanel();
        } })
      ])
    ]);
    popHost.appendChild(box);
    box.style.left = (window.innerWidth / 2 - 160) + 'px'; box.style.top = '80px';
    nameInp.focus();
  }

  // ---- data refresh --------------------------------------------------------
  function refresh() {
    return Store.list().then(function (rows) { state.comments = rows || []; renderPanel(); schedulePins(); })
      .catch(function (e) { err(e); return null; });
  }
  function err(e) { console.warn('[iDesign Review]', e); }

  // ---- public toggle + boot ------------------------------------------------
  window.__idrToggle = function () { host.style.display = (host.style.display === 'none' ? '' : 'none'); };

  if (!getEmail()) emailGate();
  renderPanel();
  refresh();
  setInterval(refresh, 5000); // near-real-time sync of the team's comments

  // ---- styles --------------------------------------------------------------
  function STYLES() { return [
    "@import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap');",
    ':host{--surf:#002B40;--surf2:#0A3A52;--field:#00263A;--line:rgba(137,242,247,.16);--primary:#017FAE;--primary2:#00A5E1;--green:#6FEEAC;--text:#E9F3F7;--muted:#7FA6B8}',
    ":host,*{box-sizing:border-box;font-family:'Lato',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    '.idr-pins{position:fixed;inset:0;pointer-events:none}',
    '.idr-capture{position:fixed;inset:0;pointer-events:auto;background:rgba(0,43,64,.10);z-index:5;cursor:crosshair}',
    '.idr-pin{position:fixed;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50% 50% 50% 3px;background:var(--primary);color:#fff;border:2px solid #E9F3F7;font-size:12px;font-weight:700;cursor:pointer;pointer-events:auto;box-shadow:0 3px 10px rgba(0,10,20,.5);display:flex;align-items:center;justify-content:center}',
    '.idr-pin.done{background:var(--green);color:#002B40;border-color:#002B40}',
    '.idr-pin.off{opacity:.45}',
    '.idr-pin:hover{filter:brightness(1.1);z-index:10}',
    '.idr-panel{position:fixed;top:16px;right:16px;width:322px;max-height:calc(100vh - 32px);background:var(--surf);border:1px solid var(--line);border-radius:16px;box-shadow:0 16px 50px rgba(0,10,20,.55);pointer-events:auto;display:flex;flex-direction:column;overflow:hidden;color:var(--text)}',
    '.idr-collapsed{width:auto;background:transparent;box-shadow:none;border:none}',
    '.idr-fab{pointer-events:auto;background:var(--primary);color:#fff;border:none;border-radius:24px;padding:12px 20px;font-weight:700;font-size:14px;cursor:pointer;box-shadow:0 6px 22px rgba(1,127,174,.5)}',
    '.idr-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:linear-gradient(135deg,#00263A,#013A52);color:#fff;border-bottom:1px solid var(--line)}',
    '.idr-brand{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:900;letter-spacing:.2px;line-height:1.2}',
    '.idr-dot{width:12px;height:12px;border-radius:50%;background:var(--primary);box-shadow:0 0 0 3px rgba(1,127,174,.28);display:inline-block}',
    '.idr-x{background:transparent;border:none;color:#9EC6D6;font-size:20px;line-height:1;cursor:pointer;padding:0 6px}',
    '.idr-x:hover{color:#fff}',
    '.idr-who{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 16px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}',
    '.idr-whoname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.idr-wholinks{display:flex;gap:8px;flex:none}',
    '.idr-link{background:none;border:none;color:var(--primary2);cursor:pointer;font-size:12px;font-weight:700;padding:2px 4px}',
    '.idr-link:hover{color:var(--green)}',
    '.idr-add{margin:12px 14px 6px;padding:12px;border:none;border-radius:12px;background:var(--primary);color:#fff;font-weight:700;font-size:14px;cursor:pointer}',
    '.idr-add:hover{background:var(--primary2)}',
    '.idr-add.on{background:transparent;border:1.5px solid var(--line);color:var(--muted)}',
    '.idr-tabs{display:flex;gap:5px;padding:6px 14px;flex-wrap:wrap}',
    '.idr-tab{border:none;background:rgba(137,242,247,.08);color:var(--muted);border-radius:20px;padding:5px 11px;font-size:11px;font-weight:700;cursor:pointer}',
    '.idr-tab.on{background:var(--primary);color:#fff}',
    '.idr-list{overflow:auto;padding:6px 10px 4px;flex:1}',
    '.idr-empty{color:var(--muted);font-size:13px;padding:20px 8px;text-align:center;line-height:1.5}',
    '.idr-item{display:flex;gap:10px;padding:10px;border-radius:12px;cursor:pointer}',
    '.idr-item:hover{background:var(--surf2)}',
    '.idr-item.done{opacity:.55}',
    '.idr-badge{flex:none;width:22px;height:22px;border-radius:50%;background:var(--primary);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}',
    '.idr-badge.done{background:var(--green);color:#002B40}',
    '.idr-item-top{display:flex;justify-content:space-between;gap:8px}',
    '.idr-au{font-size:12px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}',
    '.idr-ago{font-size:11px;color:var(--muted);flex:none}',
    '.idr-item-txt{font-size:13px;color:#CCE5EF;line-height:1.4;margin-top:2px}',
    '.idr-item-reps{font-size:11px;color:var(--primary2);margin-top:3px;font-weight:700}',
    '.idr-foot{display:flex;justify-content:space-between;align-items:center;padding:9px 16px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}',
    '.idr-pop{position:fixed;width:324px;background:var(--surf);border:1px solid var(--line);border-radius:14px;box-shadow:0 16px 50px rgba(0,10,20,.6);padding:14px;pointer-events:auto;color:var(--text);z-index:20}',
    '.idr-pop.wide{width:344px}',
    '.idr-pop-h{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:900;font-size:13px;margin-bottom:10px;color:#fff}',
    '.idr-note{font-size:12px;color:var(--muted);margin-bottom:8px}',
    '.idr-ta{width:100%;min-height:72px;border:1px solid var(--line);border-radius:10px;padding:9px;font-size:13px;resize:vertical;outline:none;background:var(--field);color:var(--text);font-family:inherit}',
    '.idr-ta:focus{border-color:var(--primary)}',
    '.idr-ta::placeholder{color:#5C7E90}',
    '.idr-input{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px;font-size:14px;outline:none;background:var(--field);color:var(--text);font-family:inherit}',
    '.idr-input:focus{border-color:var(--primary)}',
    '.idr-input::placeholder{color:#5C7E90}',
    '.idr-pop-a{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
    '.idr-btn{background:var(--primary);color:#fff;border:none;border-radius:10px;padding:9px 18px;font-weight:700;font-size:13px;cursor:pointer}',
    '.idr-btn:hover{background:var(--primary2)}',
    '.idr-btn.ghost{background:transparent;color:var(--muted);border:1.5px solid var(--line)}',
    '.idr-btn.ghost:hover{color:#fff;background:rgba(137,242,247,.06)}',
    '.idr-thread{max-height:260px;overflow:auto;margin-bottom:8px}',
    '.idr-msg{position:relative;padding:9px 9px 9px 11px;border-left:3px solid var(--primary);background:var(--field);border-radius:0 10px 10px 0;margin-bottom:6px}',
    '.idr-msg.reply{border-left-color:var(--green);margin-left:14px}',
    '.idr-msg-top{display:flex;justify-content:space-between;gap:8px}',
    '.idr-msg-txt{font-size:13px;color:#CCE5EF;line-height:1.45;margin-top:2px;white-space:pre-wrap}',
    '.idr-trash{position:absolute;top:6px;right:6px;background:none;border:none;cursor:pointer;font-size:12px;opacity:.5}',
    '.idr-trash:hover{opacity:1}',
    '.idr-scrim{position:fixed;inset:0;background:rgba(0,18,28,.80);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:40;align-items:center;justify-content:center;pointer-events:auto;padding:20px}',
    '.idr-gate{width:380px;max-width:calc(100vw - 40px);background:var(--surf);border:1px solid var(--line);border-radius:18px;box-shadow:0 30px 80px rgba(0,8,16,.75);padding:26px 24px}',
    '.idr-gate-brand{display:flex;align-items:center;gap:9px;font-weight:900;font-size:14px;color:#fff;margin-bottom:16px}',
    '.idr-gate-h{font-weight:900;font-size:19px;color:#fff;margin-bottom:6px;letter-spacing:.2px}',
    '.idr-gate .idr-input{margin-top:10px}',
    '.idr-gate .idr-btn{width:100%;padding:12px}'
  ].join('\n'); }

})();
