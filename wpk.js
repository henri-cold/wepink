/*!
 * Wepink — camada de rastreio da Meta (Pixel do navegador + Conversions API).
 *
 * Como usar numa página:
 *   <script src="/fb.js"></script>
 *   <script>wpTrack('ViewContent', { value: 32.90, content_name: '...' });</script>
 *
 * Cada evento sai por dois caminhos com o MESMO eventID:
 *   1. fbq(...)          -> Pixel no navegador
 *   2. POST /api/sync -> Conversions API (servidor)
 * A Meta deduplica pelo eventID, então quem tiver adblock ainda é contabilizado
 * pelo servidor e quem não tiver não vira venda dobrada.
 */
(function (window, document) {
  'use strict';

  var PIXEL_ID = '918538257349766';
  var STORE_KEY = 'wp_fb_v1';

  // -------------------------------------------------------------------------
  // Armazenamento (localStorage com fallback em memória — Safari privado bloqueia)
  // -------------------------------------------------------------------------
  var memory = {};

  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return memory;
    }
  }

  function save(data) {
    memory = data;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function getCookie(name) {
    var m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : '';
  }

  function setCookie(name, value, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + (days || 90) * 86400000);
      document.cookie = name + '=' + value + ';expires=' + d.toUTCString() +
        ';path=/;SameSite=Lax' + (location.protocol === 'https:' ? ';Secure' : '');
    } catch (e) {}
  }

  var store = load();

  // -------------------------------------------------------------------------
  // Identificadores de atribuição
  // -------------------------------------------------------------------------

  // fbc = clique no anúncio. É o dado que mais pesa na atribuição, e é o que
  // mais se perde: o cookie só existe no domínio onde o Pixel rodou e some se o
  // Pixel for bloqueado. Então reconstruímos a partir do fbclid da URL e
  // guardamos, para o Purchase (que acontece minutos depois) ainda ter ele.
  function captureClickId() {
    var params = new URLSearchParams(location.search);
    var fbclid = params.get('fbclid');

    if (fbclid) {
      store.fbclid = fbclid;
      if (!getCookie('_fbc')) {
        var fbc = 'fb.1.' + Date.now() + '.' + fbclid;
        setCookie('_fbc', fbc, 90);
        store.fbc = fbc;
      }
      // Guarda a origem do tráfego junto — ajuda a conferir a atribuição depois.
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
        var v = params.get(k);
        if (v) store[k] = v;
      });
      save(store);
    }
  }

  // fbp = identificador do navegador criado pelo Pixel. Persistimos porque o
  // cookie pode ainda não existir no primeiro evento da primeira visita.
  function syncCookies() {
    var fbp = getCookie('_fbp');
    var fbc = getCookie('_fbc');
    var changed = false;
    if (fbp && fbp !== store.fbp) { store.fbp = fbp; changed = true; }
    if (fbc && fbc !== store.fbc) { store.fbc = fbc; changed = true; }
    if (changed) save(store);
  }

  // ID anônimo estável: serve de external_id mesmo antes do cliente digitar
  // qualquer dado, e costura os eventos do mesmo visitante entre as páginas.
  function anonId() {
    if (!store.anonId) {
      var rnd;
      try {
        rnd = window.crypto.randomUUID();
      } catch (e) {
        rnd = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
      }
      store.anonId = rnd;
      save(store);
    }
    return store.anonId;
  }

  captureClickId();
  anonId();

  // -------------------------------------------------------------------------
  // Dados do cliente (Advanced Matching)
  // -------------------------------------------------------------------------

  var USER_FIELDS = ['email', 'phone', 'firstName', 'lastName', 'cpf', 'cep', 'city', 'state', 'birthdate', 'gender'];

  /** Guarda o que o cliente digitou. Chame assim que tiver nome/CPF/e-mail. */
  function wpSetUser(data) {
    if (!data) return;
    var changed = false;
    USER_FIELDS.forEach(function (k) {
      var v = data[k];
      if (v !== undefined && v !== null && String(v).trim() !== '' && store[k] !== v) {
        store[k] = String(v).trim();
        changed = true;
      }
    });
    if (changed) {
      save(store);
      // Reenvia o Advanced Matching pro Pixel com os dados novos.
      applyAdvancedMatching();
    }
  }

  // O fbq hasheia sozinho os valores crus do Advanced Matching.
  function advancedMatchingPayload() {
    var am = { external_id: store.anonId, country: 'br' };
    if (store.email) am.em = store.email.toLowerCase().trim();
    if (store.phone) am.ph = String(store.phone).replace(/\D/g, '');
    if (store.firstName) am.fn = store.firstName.toLowerCase();
    if (store.lastName) am.ln = store.lastName.toLowerCase();
    if (store.cep) am.zp = String(store.cep).replace(/\D/g, '');
    if (store.city) am.ct = store.city.toLowerCase();
    if (store.state) am.st = store.state.toLowerCase();
    if (store.cpf) am.external_id = String(store.cpf).replace(/\D/g, '');
    return am;
  }

  var initialized = false;

  function applyAdvancedMatching() {
    if (!window.fbq) return;
    try {
      // Reinicializar com o mesmo ID atualiza o Advanced Matching sem duplicar o pixel.
      window.fbq('init', PIXEL_ID, advancedMatchingPayload());
      initialized = true;
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // Boot do Pixel
  // -------------------------------------------------------------------------
  (function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  // autoConfig fica LIGADO de propósito: é o Advanced Matching automático, que
  // pesca e-mail/telefone dos campos do formulário por conta própria.
  applyAdvancedMatching();

  // O Pixel escreve _fbp logo depois de carregar; recolhemos em seguida.
  setTimeout(syncCookies, 800);
  setTimeout(syncCookies, 3000);

  // -------------------------------------------------------------------------
  // Disparo de eventos
  // -------------------------------------------------------------------------

  /** ID determinístico quando há transação, aleatório no resto. */
  function wpEventId(prefix, ref) {
    if (ref) return prefix + '_' + ref;
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  var PIXEL_KEYS = ['value', 'currency', 'content_name', 'content_category', 'content_type', 'content_ids', 'contents', 'num_items', 'order_id', 'search_string'];

  /**
   * Dispara um evento no Pixel e na Conversions API.
   * @param {string} eventName  Purchase, InitiateCheckout, ...
   * @param {object} [params]   value, currency, content_name, transactionId, ...
   * @param {object} [options]  { eventId, beacon: true }
   */
  function wpTrack(eventName, params, options) {
    params = params || {};
    options = options || {};
    syncCookies();

    var eventId = options.eventId || params.eventId ||
      wpEventId(eventName.toLowerCase(), params.transactionId);

    // 1) Pixel do navegador — só as chaves que a Meta reconhece.
    var pixelPayload = {};
    PIXEL_KEYS.forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') pixelPayload[k] = params[k];
    });
    if (params.transactionId && !pixelPayload.order_id) pixelPayload.order_id = params.transactionId;

    try {
      if (!initialized) applyAdvancedMatching();
      window.fbq('track', eventName, pixelPayload, { eventID: eventId });
    } catch (e) {}

    // 2) Conversions API — leva tudo que temos de identidade.
    var capi = {
      eventName: eventName,
      eventId: eventId,
      eventTime: Math.floor(Date.now() / 1000),
      sourceUrl: location.href,
      currency: params.currency || 'BRL',
      fbp: store.fbp || getCookie('_fbp') || undefined,
      fbc: store.fbc || getCookie('_fbc') || undefined,
      fbclid: store.fbclid || undefined,
      anonId: store.anonId
    };

    USER_FIELDS.forEach(function (k) { if (store[k]) capi[k] = store[k]; });
    Object.keys(params).forEach(function (k) {
      if (k !== 'eventId' && params[k] !== undefined && params[k] !== null && params[k] !== '') capi[k] = params[k];
    });

    sendToServer(capi, options.beacon);
    return eventId;
  }

  function sendToServer(payload, useBeacon) {
    var body = JSON.stringify(payload);
    try {
      // Em saída de página o fetch normal é cancelado; o beacon sobrevive.
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon('/api/sync', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------------
  window.wpTrack = wpTrack;
  window.wpSetUser = wpSetUser;
  window.wpEventId = wpEventId;
  window.wpFbData = function () { return store; };
  window.WP_PIXEL_ID = PIXEL_ID;

  // PageView em toda página que carregar este arquivo.
  wpTrack('PageView');
})(window, document);
