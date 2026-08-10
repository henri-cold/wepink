// Recebe eventos do navegador e reenvia pela Conversions API (server-side).
// O Pixel do navegador dispara o MESMO evento com o MESMO eventID, então a Meta
// deduplica e fica com o que chegar primeiro — na prática, quem o adblock
// bloquear no browser ainda chega aqui pelo servidor.
//
// Aceita { eventName, ... } ou { events: [ {...}, {...} ] }.

const { sendFbEvents, requestContext, SITE_URL } = require('./_fbcapi');

// Só eventos que a gente realmente usa. Evita que alguém use a rota como relay.
const ALLOWED_EVENTS = new Set([
  'PageView',
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'AddPaymentInfo',
  'Purchase',
  'Lead',
  'CompleteRegistration'
]);

// Teto de valor por evento — impede que um payload adulterado envie R$ 999.999
// e destrua a otimização de valor da campanha.
const MAX_VALUE = 5000;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body;
}

function normalizeIncoming(raw, ctx, fallbackUrl) {
  let value = raw.value;
  if (typeof value === 'string') value = Number(value.replace(',', '.'));
  if (!isFinite(value) || value < 0 || value > MAX_VALUE) value = undefined;

  return {
    eventName: raw.eventName,
    eventId: raw.eventId,
    eventTime: raw.eventTime,
    actionSource: 'website',
    sourceUrl: raw.sourceUrl || fallbackUrl || SITE_URL,

    value: value,
    currency: raw.currency || 'BRL',
    contentName: raw.content_name || raw.contentName,
    contentCategory: raw.content_category || raw.contentCategory,
    contentType: raw.content_type || raw.contentType,
    contentId: raw.content_id || raw.contentId,
    contents: raw.contents,
    numItems: raw.num_items || raw.numItems,
    orderId: raw.transactionId || raw.orderId || raw.order_id,

    // Identidade do cliente (o helper normaliza e faz o SHA-256).
    email: raw.email,
    phone: raw.phone,
    firstName: raw.firstName,
    lastName: raw.lastName,
    city: raw.city,
    state: raw.state,
    zip: raw.zip || raw.cep,
    country: raw.country || ctx.country,
    birthdate: raw.birthdate,
    gender: raw.gender,
    cpf: raw.cpf,
    externalId: raw.externalId,
    anonId: raw.anonId,

    // Cookies do Pixel + contexto da conexão: o que mais pesa na atribuição.
    fbp: raw.fbp,
    fbc: raw.fbc,
    fbclid: raw.fbclid,
    ip: ctx.ip,
    userAgent: ctx.userAgent || raw.userAgent
  };
}

module.exports = async function handler(req, res) {
  // sendBeacon manda text/plain; aceitamos qualquer content-type no POST.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    const body = parseBody(req);
    const ctx = requestContext(req);
    const referer = req.headers && req.headers.referer;

    const incoming = Array.isArray(body.events) ? body.events : [body];
    const events = incoming
      .filter(function (e) { return e && ALLOWED_EVENTS.has(e.eventName); })
      .slice(0, 10)
      .map(function (e) { return normalizeIncoming(e, ctx, referer); });

    if (!events.length) {
      return res.status(400).json({ ok: false, error: 'nenhum evento válido' });
    }

    const result = await sendFbEvents(events);
    return res.status(200).json({ ok: true, capi: !!result.ok, count: events.length });
  } catch (e) {
    // Tracking nunca pode virar erro visível pro cliente.
    console.error('[fb-event] erro', e && e.message);
    return res.status(200).json({ ok: false });
  }
};
