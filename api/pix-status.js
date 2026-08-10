// Consulta o status de uma cobrança PIX na VexoPay.
//
// Além de responder o status, esta rota é o principal ponto de disparo do
// Purchase para a Meta: é aqui que o pagamento é detectado enquanto o cliente
// ainda está com a página aberta, ou seja, é o único momento em que temos
// fbc/fbp/IP/user-agent + e-mail/CPF/nome juntos. O webhook da VexoPay cobre
// quem fechou a aba, e o Pixel do navegador cobre o resto — os três usam o
// mesmo event_id ('purchase_<transactionId>'), então a Meta deduplica.
//
// Aceita GET (?transactionId=...) e POST ({ transactionId, tracking: {...} }).
// O POST é o preferido: manda o contexto de rastreio sem expor PII na URL.

const { sendFbEvent, requestContext, SITE_URL } = require('./_fbcapi');

const VEXO_CI = process.env.VEXO_CI;
const VEXO_CS = process.env.VEXO_CS;
const BASE_URL = 'https://www.vexopay.com.br/api';

// Evita reenviar o Purchase a cada poll dentro da mesma instância da função.
// Não é garantia global (serverless escala horizontalmente) — a garantia real
// é o event_id, que faz a Meta deduplicar.
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

async function firePurchase(txId, vexoData, tracking, ctx, referer) {
  if (purchasesSent.has(txId)) return;
  rememberPurchase(txId);

  const t = tracking || {};
  const nameParts = String(t.name || vexoData.payerName || '').trim().split(/\s+/);

  // O valor vem da VexoPay (fonte da verdade), nunca do que o navegador mandou.
  const amount = Number(vexoData.amount);

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
      cpf: t.cpf || vexoData.payerDocument,
      anonId: t.anonId,

      fbp: t.fbp,
      fbc: t.fbc,
      fbclid: t.fbclid,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    });
  } catch (e) {
    // Um erro de tracking não pode alterar a resposta de status pro cliente.
    console.error('[pix-status] falha ao enviar Purchase', txId, e && e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  if (!VEXO_CI || !VEXO_CS) {
    return res.status(500).json({ success: false, error: 'Credenciais da VexoPay não configuradas no servidor (VEXO_CI/VEXO_CS).' });
  }

  try {
    const body = req.method === 'POST' ? parseBody(req) : {};
    const transactionId = String(
      (req.query && req.query.transactionId) || body.transactionId || ''
    ).trim();

    if (!transactionId) return res.status(400).json({ success: false, error: 'transactionId ausente.' });

    const vexoRes = await fetch(BASE_URL + '/gateway/pix-status?transactionId=' + encodeURIComponent(transactionId), {
      method: 'GET',
      headers: { 'ci': VEXO_CI, 'cs': VEXO_CS }
    });

    const data = await vexoRes.json().catch(() => ({}));
    if (!vexoRes.ok) {
      return res.status(vexoRes.status).json({
        success: false,
        error: (data && (data.error || data.message)) || 'Erro ao consultar status.'
      });
    }

    // Pago? Dispara o Purchase antes de responder — a função serverless é
    // congelada assim que a resposta sai, então não dá para fazer isso "depois".
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
    console.error('[pix-status] erro', e && e.message);
    return res.status(500).json({ success: false, error: 'Erro interno ao consultar status.' });
  }
};
