// Conversions API (CAPI) da Meta / Facebook Ads.
// Arquivos com prefixo "_" NÃO viram rota na Vercel — é só um módulo compartilhado.
//
// Referência: https://developers.facebook.com/docs/marketing-api/conversions-api
//
// Variáveis de ambiente (Vercel > Settings > Environment Variables):
//   FB_ACCESS_TOKEN     -> token da Conversions API (SECRETO, só no servidor)  [obrigatório]
//   FB_PIXEL_ID         -> ID do dataset/pixel                                  [default abaixo]
//   FB_API_VERSION      -> versão da Graph API (default v21.0)
//   FB_TEST_EVENT_CODE  -> opcional, só enquanto testa na aba "Testar eventos"
//   FB_DEFAULT_COUNTRY  -> ISO-2 usado quando o país não vem do front (default br)
//   FB_DEFAULT_PHONE_CC -> DDI usado para normalizar telefone (default 55)
//   SITE_URL            -> URL pública do site (usada quando não há event_source_url)

'use strict';

const crypto = require('crypto');

const FB_PIXEL_ID = String(process.env.FB_PIXEL_ID || '918538257349766').trim();
const FB_ACCESS_TOKEN = String(process.env.FB_ACCESS_TOKEN || '').trim();
const FB_API_VERSION = String(process.env.FB_API_VERSION || 'v21.0').trim();
const FB_TEST_EVENT_CODE = String(process.env.FB_TEST_EVENT_CODE || '').trim();
const DEFAULT_COUNTRY = String(process.env.FB_DEFAULT_COUNTRY || 'br').trim().toLowerCase();
const DEFAULT_PHONE_CC = String(process.env.FB_DEFAULT_PHONE_CC || '55').replace(/\D/g, '');
const SITE_URL = String(process.env.SITE_URL || 'https://wepink-flax.vercel.app').replace(/\/+$/, '');

const GRAPH_URL = 'https://graph.facebook.com/' + FB_API_VERSION + '/' + FB_PIXEL_ID + '/events';

// ---------------------------------------------------------------------------
// Normalização + hash
// A Meta exige SHA-256 (hex minúsculo) nos dados pessoais, e cada campo tem uma
// regra própria de normalização ANTES do hash. Sem isso o match quality despenca.
// ---------------------------------------------------------------------------

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Já veio hasheado do cliente? (64 hex) Então não hasheia de novo.
function isHashed(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim());
}

function stripAccents(value) {
  return String(value).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function hashField(value, normalize) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (isHashed(raw)) return raw.toLowerCase();
  const normalized = normalize ? normalize(raw) : raw.toLowerCase();
  if (!normalized) return undefined;
  return sha256(normalized);
}

// em: minúsculo, sem espaços. Descarta o que claramente não é e-mail.
function normEmail(v) {
  const e = v.trim().toLowerCase().replace(/\s+/g, '');
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

// ph: só dígitos, com DDI. Números BR de 10/11 dígitos ganham o 55 na frente.
function normPhone(v) {
  let d = String(v).replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.length === 10 || d.length === 11) d = DEFAULT_PHONE_CC + d;
  if (d.length < 8 || d.length > 15) return '';
  return d;
}

// fn/ln: minúsculo, sem acento, sem pontuação e sem espaços.
function normName(v) {
  return stripAccents(v).toLowerCase().replace(/[^a-z]/g, '');
}

// ct (cidade): minúsculo, sem acento, sem espaço/pontuação.
function normCity(v) {
  return stripAccents(v).toLowerCase().replace(/[^a-z]/g, '');
}

// st (estado): sigla de 2 letras minúscula.
function normState(v) {
  return stripAccents(v).toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
}

// zp (CEP): só dígitos.
function normZip(v) {
  return String(v).replace(/\D/g, '');
}

// country: ISO-2 minúsculo.
function normCountry(v) {
  const c = stripAccents(v).toLowerCase().replace(/[^a-z]/g, '');
  return c.length === 2 ? c : '';
}

// db (nascimento): YYYYMMDD. Aceita dd/mm/aaaa e aaaa-mm-dd.
function normBirthdate(v) {
  const s = String(v).trim();
  let m = s.match(/^(\d{2})\D(\d{2})\D(\d{4})$/);
  if (m) return m[3] + m[2] + m[1];
  m = s.match(/^(\d{4})\D?(\d{2})\D?(\d{2})$/);
  if (m) return m[1] + m[2] + m[3];
  const d = s.replace(/\D/g, '');
  return d.length === 8 ? d : '';
}

// ge: f | m
function normGender(v) {
  const g = String(v).trim().toLowerCase();
  if (g.startsWith('f')) return 'f';
  if (g.startsWith('m')) return 'm';
  return '';
}

// external_id: identificador estável nosso (CPF, id anônimo do navegador...).
function normExternalId(v) {
  return String(v).trim().toLowerCase();
}

// Monta um array hasheado sem duplicatas nem vazios.
function hashList(values, normalize) {
  const out = [];
  const seen = new Set();
  (Array.isArray(values) ? values : [values]).forEach(function (v) {
    const h = hashField(v, normalize);
    if (h && !seen.has(h)) { seen.add(h); out.push(h); }
  });
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// user_data
// ---------------------------------------------------------------------------

// fbc precisa do formato fb.<subdomainIndex>.<timestamp>.<fbclid>.
// Se o front só conseguiu capturar o fbclid cru, montamos aqui.
function buildFbc(fbc, fbclid, eventTimeMs) {
  const direct = String(fbc || '').trim();
  if (/^fb\.\d\.\d+\..+/.test(direct)) return direct;
  const id = String(fbclid || '').trim();
  if (!id) return undefined;
  return 'fb.1.' + (eventTimeMs || Date.now()) + '.' + id;
}

// IPv6 do Vercel pode vir com sufixo de porta/zona; a Meta rejeita nesse caso.
function cleanIp(ip) {
  const v = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!v || v === '::1' || v === '127.0.0.1') return undefined;
  return v.split('%')[0];
}

function buildUserData(u, eventTimeMs) {
  u = u || {};
  const ud = {};

  const email = hashList(u.email, normEmail);
  if (email) ud.em = email;

  const phone = hashList(u.phone, normPhone);
  if (phone) ud.ph = phone;

  const firstName = hashList(u.firstName, normName);
  if (firstName) ud.fn = firstName;

  const lastName = hashList(u.lastName, normName);
  if (lastName) ud.ln = lastName;

  const city = hashList(u.city, normCity);
  if (city) ud.ct = city;

  const state = hashList(u.state, normState);
  if (state) ud.st = state;

  const zip = hashList(u.zip, normZip);
  if (zip) ud.zp = zip;

  const country = hashList(u.country || DEFAULT_COUNTRY, normCountry);
  if (country) ud.country = country;

  const birthdate = hashList(u.birthdate, normBirthdate);
  if (birthdate) ud.db = birthdate;

  const gender = hashList(u.gender, normGender);
  if (gender) ud.ge = gender;

  // CPF + id anônimo do navegador viram external_id (a Meta aceita vários).
  const externalIds = [];
  if (u.cpf) externalIds.push(String(u.cpf).replace(/\D/g, ''));
  if (u.externalId) externalIds.push(u.externalId);
  if (u.anonId) externalIds.push(u.anonId);
  const ext = hashList(externalIds, normExternalId);
  if (ext) ud.external_id = ext;

  // Estes NÃO são hasheados.
  const fbp = String(u.fbp || '').trim();
  if (fbp) ud.fbp = fbp;

  const fbc = buildFbc(u.fbc, u.fbclid, eventTimeMs);
  if (fbc) ud.fbc = fbc;

  const ip = cleanIp(u.ip);
  if (ip) ud.client_ip_address = ip;

  const ua = String(u.userAgent || '').trim();
  if (ua) ud.client_user_agent = ua;

  return ud;
}

// Quantas chaves de match o evento leva — útil pra diagnosticar no log.
function matchKeyCount(ud) {
  return Object.keys(ud || {}).length;
}

// ---------------------------------------------------------------------------
// custom_data
// ---------------------------------------------------------------------------

function toNumber(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : undefined;
}

function buildCustomData(c) {
  c = c || {};
  const cd = { currency: String(c.currency || 'BRL').toUpperCase() };

  const value = toNumber(c.value);
  if (value !== undefined) cd.value = Math.round(value * 100) / 100;

  if (c.contentName) cd.content_name = String(c.contentName);
  if (c.contentCategory) cd.content_category = String(c.contentCategory);
  cd.content_type = String(c.contentType || 'product');

  // contents/content_ids melhoram catálogo e otimização de valor.
  if (Array.isArray(c.contents) && c.contents.length) {
    cd.contents = c.contents.map(function (item) {
      const entry = { id: String(item.id || c.contentId || 'wepink-001') };
      const q = toNumber(item.quantity);
      entry.quantity = q && q > 0 ? Math.round(q) : 1;
      const p = toNumber(item.item_price !== undefined ? item.item_price : item.price);
      if (p !== undefined) entry.item_price = p;
      if (item.title) entry.title = String(item.title);
      return entry;
    });
  } else if (c.contentId || c.contentName) {
    const entry = { id: String(c.contentId || 'wepink-001'), quantity: 1 };
    if (value !== undefined) entry.item_price = value;
    if (c.contentName) entry.title = String(c.contentName);
    cd.contents = [entry];
  }

  if (cd.contents) cd.content_ids = cd.contents.map(function (i) { return i.id; });

  const numItems = toNumber(c.numItems);
  if (numItems !== undefined) cd.num_items = Math.round(numItems);
  else if (cd.contents) cd.num_items = cd.contents.reduce(function (s, i) { return s + (i.quantity || 1); }, 0);

  if (c.orderId) cd.order_id = String(c.orderId);
  if (c.searchString) cd.search_string = String(c.searchString);
  if (c.status) cd.status = String(c.status);
  if (c.predictedLtv !== undefined) {
    const ltv = toNumber(c.predictedLtv);
    if (ltv !== undefined) cd.predicted_ltv = ltv;
  }

  return cd;
}

// ---------------------------------------------------------------------------
// Montagem e envio
// ---------------------------------------------------------------------------

// event_time precisa estar dentro dos últimos 7 dias e no máximo 1h no futuro.
function normalizeEventTime(eventTime) {
  const now = Math.floor(Date.now() / 1000);
  let t = Number(eventTime);
  if (!isFinite(t) || t <= 0) return now;
  if (t > 1e12) t = Math.floor(t / 1000); // veio em milissegundos
  const min = now - 6 * 24 * 60 * 60;     // margem de segurança dentro dos 7 dias
  const max = now + 60;
  if (t < min) return min;
  if (t > max) return now;
  return t;
}

function buildEvent(event) {
  const eventTimeSec = normalizeEventTime(event.eventTime);
  const userData = buildUserData({
    email: event.email,
    phone: event.phone,
    firstName: event.firstName,
    lastName: event.lastName,
    city: event.city,
    state: event.state,
    zip: event.zip,
    country: event.country,
    birthdate: event.birthdate,
    gender: event.gender,
    cpf: event.cpf,
    externalId: event.externalId,
    anonId: event.anonId,
    fbp: event.fbp,
    fbc: event.fbc,
    fbclid: event.fbclid,
    ip: event.ip,
    userAgent: event.userAgent
  }, eventTimeSec * 1000);

  const payload = {
    event_name: event.eventName,
    event_time: eventTimeSec,
    action_source: event.actionSource || 'website',
    user_data: userData,
    custom_data: buildCustomData(event)
  };

  if (event.eventId) payload.event_id = String(event.eventId);

  const url = event.sourceUrl || SITE_URL;
  if (url) payload.event_source_url = url;

  return payload;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Erros transitórios valem retry; erro de payload (400 com código conhecido) não.
function isRetryable(status, body) {
  if (!status) return true;                 // falha de rede
  if (status >= 500) return true;
  if (status === 429) return true;
  const code = body && body.error && body.error.code;
  return code === 1 || code === 2 || code === 4 || code === 17 || code === 613;
}

// Função serverless da Vercel morre em ~10s. Como o envio acontece ANTES de
// responder o cliente (a função congela assim que a resposta sai), o retry
// precisa caber nesse orçamento — senão o polling do checkout quebra.
const REQUEST_TIMEOUT_MS = 4000;
const TOTAL_BUDGET_MS = 8000;

async function postToMeta(payload) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await r.json().catch(function () { return {}; });
    return { status: r.status, ok: r.ok, body: body };
  } catch (e) {
    return { status: 0, ok: false, body: {}, error: (e && e.message) || 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia um ou mais eventos para a Conversions API.
 * Nunca lança exceção — tracking jamais pode derrubar checkout ou webhook.
 */
async function sendFbEvents(events) {
  const list = (Array.isArray(events) ? events : [events]).filter(function (e) { return e && e.eventName; });
  if (!list.length) return { ok: false, skipped: 'sem eventos' };

  if (!FB_ACCESS_TOKEN) {
    console.warn('[FB CAPI] FB_ACCESS_TOKEN ausente — evento(s) descartado(s):',
      list.map(function (e) { return e.eventName; }).join(','));
    return { ok: false, skipped: 'sem token' };
  }

  let data;
  try {
    data = list.map(buildEvent);
  } catch (e) {
    console.error('[FB CAPI] falha ao montar payload:', e && e.message);
    return { ok: false, error: 'payload inválido' };
  }

  const payload = { data: data, access_token: FB_ACCESS_TOKEN };
  if (FB_TEST_EVENT_CODE) payload.test_event_code = FB_TEST_EVENT_CODE;

  const label = data.map(function (e) {
    return e.event_name + '(' + matchKeyCount(e.user_data) + ' keys)';
  }).join(',');

  const maxAttempts = 3;
  const startedAt = Date.now();
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await postToMeta(payload);

    if (last.ok) {
      console.log('[FB CAPI] ok', label,
        'received=' + (last.body && last.body.events_received),
        'trace=' + (last.body && last.body.fbtrace_id));
      return { ok: true, response: last.body };
    }

    const retryable = isRetryable(last.status, last.body);
    console.error('[FB CAPI] falha (tentativa ' + attempt + '/' + maxAttempts + ')', label,
      'status=' + last.status,
      JSON.stringify(last.body && last.body.error ? last.body.error : (last.error || last.body)));

    const backoff = attempt === 1 ? 400 : 1200;
    const budgetLeft = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (!retryable || attempt === maxAttempts) break;
    if (budgetLeft < backoff + REQUEST_TIMEOUT_MS) {
      console.error('[FB CAPI] sem orçamento de tempo para nova tentativa', label);
      break;
    }
    await sleep(backoff);
  }

  return { ok: false, status: last && last.status, response: last && last.body };
}

// Compatibilidade com o código antigo (envio de um evento só).
async function sendFbEvent(event) {
  return sendFbEvents([event]);
}

// Extrai IP real e user-agent de uma request da Vercel.
function requestContext(req) {
  const headers = (req && req.headers) || {};
  const fwd = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd
    || headers['x-real-ip']
    || headers['x-vercel-forwarded-for']
    || (req && req.socket && req.socket.remoteAddress)
    || '';
  // Só o país vem do IP. Cidade/estado por geolocalização de IP erram muito em
  // celular (saem no POP da operadora) e sujariam o match em vez de melhorar.
  return {
    ip: cleanIp(ip),
    userAgent: headers['user-agent'] || '',
    country: (headers['x-vercel-ip-country'] || '').toLowerCase() || undefined
  };
}

module.exports = {
  sendFbEvent,
  sendFbEvents,
  requestContext,
  SITE_URL,
  FB_PIXEL_ID
};
