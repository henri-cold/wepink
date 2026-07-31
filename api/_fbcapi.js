// Helper da Conversions API (CAPI) da Meta / Facebook Ads.
// Arquivos com prefixo "_" NÃO viram rota na Vercel — é só um módulo compartilhado.
//
// Configure na Vercel (Settings > Environment Variables):
//   FB_ACCESS_TOKEN  -> token da Conversions API (SECRETO, só no servidor)
//   FB_PIXEL_ID      -> ID do pixel (opcional; default abaixo)
//   FB_TEST_EVENT_CODE -> opcional, só para testar no "Testar eventos" do Gerenciador

const crypto = require('crypto');

const FB_PIXEL_ID = process.env.FB_PIXEL_ID || '160887716420039';
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const FB_API_VERSION = process.env.FB_API_VERSION || 'v19.0';
const FB_TEST_EVENT_CODE = process.env.FB_TEST_EVENT_CODE || '';

// Dados pessoais devem ir com hash SHA-256 (email, telefone, nome, cpf).
function sha256(value) {
  if (!value && value !== 0) return undefined;
  const v = String(value).trim().toLowerCase();
  if (!v) return undefined;
  return crypto.createHash('sha256').update(v).digest('hex');
}

async function sendFbEvent(event) {
  if (!FB_ACCESS_TOKEN) {
    console.warn('[FB CAPI] FB_ACCESS_TOKEN não configurado — evento ignorado:', event && event.eventName);
    return { ok: false, skipped: true };
  }

  const userData = {};
  if (event.email) userData.em = [sha256(event.email)];
  if (event.phone) userData.ph = [sha256(String(event.phone).replace(/\D/g, ''))];
  if (event.firstName) userData.fn = [sha256(event.firstName)];
  if (event.lastName) userData.ln = [sha256(event.lastName)];
  if (event.externalId) userData.external_id = [sha256(String(event.externalId).replace(/\D/g, ''))]; // CPF
  if (event.ip) userData.client_ip_address = event.ip;
  if (event.userAgent) userData.client_user_agent = event.userAgent;
  if (event.fbp) userData.fbp = event.fbp;
  if (event.fbc) userData.fbc = event.fbc;

  const customData = { currency: event.currency || 'BRL' };
  if (typeof event.value === 'number' && !isNaN(event.value)) customData.value = event.value;
  if (event.orderId) customData.order_id = event.orderId;

  const payload = {
    data: [{
      event_name: event.eventName,
      event_time: event.eventTime || Math.floor(Date.now() / 1000),
      event_id: event.eventId,
      action_source: event.actionSource || 'website',
      event_source_url: event.sourceUrl || undefined,
      user_data: userData,
      custom_data: customData
    }]
  };
  if (FB_TEST_EVENT_CODE) payload.test_event_code = FB_TEST_EVENT_CODE;

  const url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' + FB_PIXEL_ID +
    '/events?access_token=' + encodeURIComponent(FB_ACCESS_TOKEN);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.error('[FB CAPI] erro ao enviar', event.eventName, JSON.stringify(j));
    else console.log('[FB CAPI] enviado', event.eventName, 'event_id=' + event.eventId);
    return { ok: r.ok, response: j };
  } catch (e) {
    console.error('[FB CAPI] falha de rede', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

module.exports = { sendFbEvent };
