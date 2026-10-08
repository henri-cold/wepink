// Consulta o status de uma cobrança PIX na SafiPay.
//
// Igual ao pix-status da VexoPay: é aqui que o Purchase é disparado enquanto
// o cliente ainda está com a aba aberta. O webhook cobre quem fechou a aba.
// Os três caminhos (polling, webhook, Pixel) usam o mesmo event_id
// ('purchase_<transactionId>') — a Meta deduplica e conta uma venda só.
//
// Aceita GET (?transactionId=...) e POST ({ transactionId, tracking: {...} }).

const { sendFbEvent, requestContext, SITE_URL } = require('./_fbcapi');

const SAFI_CI = process.env.SAFIPAY_CLIENT_ID;
const SAFI_CS = process.env.SAFIPAY_CLIENT_SECRET;
const BASE_URL = 'https://www.safipaybr.com';

// Evita reenviar o Purchase a cada poll dentro da mesma instância da função.
// A garantia real é o event_id — a Meta deduplica.
const purchasesSent = new Set();

function rememberPurchase(txId) {
  if (purchasesSent.size > 500) purchasesSent.clear();
  purchasesSent.add(txId);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
  }
  return req.body;
}

async function firePurchase(txId, safiData, tracking, ctx, referer) {
  if (purchasesSent.has(txId)) return;
  rememberPurchase(txId);

  const t = tracking || {};
  const nameParts = String(t.name || safiData.payerName || '').trim().split(/\s+/);

  // O valor vem da SafiPay (fonte da verdade), nunca do que o navegador mandou.
  const amount = Number(safiData.amount);

  try {
    await sendFbEvent({
      eventName: 'Purchase',
      eventId: 'purchase_' + txId,
      actionSource: 'website',
      sourceUrl: t.sourceUrl || referer || SITE_URL,

      value: isFinite(amount) && amount > 0 ? amount : t.value,
      currency: 'BRL',
      orderId: txId,
      contentName: t.content_name || 'Body Splash Liberte 200ml',
      contentType: 'product',
      contentId: t.content_id,
      contents: t.contents,

      email: t.email,
      phone: t.phone,
      firstName: nameParts[0] || undefined,
      lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined,
      zip: t.cep,
      country: t.country || ctx.country,
      cpf: t.cpf || safiData.payerDocument,
      anonId: t.anonId,

      fbp: t.fbp,
      fbc: t.fbc,
      fbclid: t.fbclid,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    });
  } catch (e) {
    console.error('[safi-status] falha ao enviar Purchase', txId, e && e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  if (!SAFI_CI || !SAFI_CS) {
    return res.status(500).json({ success: false, error: 'Credenciais da SafiPay não configuradas (SAFIPAY_CLIENT_ID/SAFIPAY_CLIENT_SECRET).' });
  }

  try {
    const body = req.method === 'POST' ? parseBody(req) : {};
    const transactionId = String(
      (req.query && req.query.transactionId) || body.transactionId || ''
    ).trim();

    if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId ausente.' });

    const safiRes = await fetch(BASE_URL + '/api/gateway/pix-status?transactionId=' + encodeURIComponent(transactionId), {
      method: 'GET',
      headers: { 'ci': SAFI_CI, 'cs': SAFI_CS }
    });

    const data = await safiRes.json().catch(() => ({}));
    if (!safiRes.ok) {
      return res.status(safiRes.status).json({
        success: false,
        error: (data && (data.error || data.message)) || 'Erro ao consultar status.'
      });
    }

    // Pago? Dispara o Purchase antes de responder.
    // Obs.: SafiPay confere o pagamento no banco ao consultar pix-status —
    // se o Pix entrou nesse momento, ele credita o saldo e dispara o webhook
    // também aqui, mas o event_id garante que a Meta não duplique.
    const status = data && data.data && data.data.status;
    if (status === 'paid') {
      await firePurchase(
        transactionId,
        data.data || {},
        body.tracking,
        requestContext(req),
        req.headers && req.headers.referer
      );
    }

    return res.status(200).json(data);
  } catch (e) {
    console.error('[safi-status] erro', e && e.message);
    return res.status(500).json({ success: false, error: 'Erro interno ao consultar status.' });
  }
};
