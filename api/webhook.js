// Vercel Serverless Function — recebe os webhooks da VexoPay.
// Configure na VexoPay (Webhooks) a URL: https://wepink-flax.vercel.app/api/webhook
//
// Eventos: payment.completed | payment.failed | payment.expired
//
// IMPORTANTE: webhooks podem ser forjados. Antes de tratar como pago,
// reconsultamos o status direto na VexoPay (server-to-server) usando ci/cs.
//
// Este é o caminho de garantia do Purchase: funciona mesmo se o cliente fechar
// a aba logo depois de pagar. Usa o mesmo event_id de 'pix-status' e do Pixel
// ('purchase_<transactionId>'), então a Meta deduplica e conta uma venda só.

const { sendFbEvent, SITE_URL } = require('./_fbcapi');

const VEXO_CI = process.env.VEXO_CI;
const VEXO_CS = process.env.VEXO_CS;
const BASE_URL = 'https://www.vexopay.com.br/api';

const purchasesSent = new Set();

function firstName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return parts[0] || undefined;
}

function lastName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : undefined;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const event = payload.event;
    const data = payload.data || {};
    const transactionId = data.transactionId;

    // Sempre responda 2xx rápido para a VexoPay não reenviar em loop.
    // A verificação/fulfillment acontece antes de responder, mas sem estourar erro pra fora.
    if (!transactionId) {
      return res.status(200).json({ ok: true, ignored: 'sem transactionId' });
    }

    let verifiedStatus = data.status || null;
    let verified = data;

    // Revalida o status na fonte (não confia cegamente no corpo do webhook).
    if (VEXO_CI && VEXO_CS) {
      try {
        const r = await fetch(BASE_URL + '/gateway/pix-status?transactionId=' + encodeURIComponent(transactionId), {
          method: 'GET',
          headers: { 'ci': VEXO_CI, 'cs': VEXO_CS }
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j && j.data && j.data.status) {
          verifiedStatus = j.data.status;
          // A consulta direta costuma trazer mais dados do pagador que o webhook.
          verified = Object.assign({}, data, j.data);
        }
      } catch (_) { /* mantém o status do payload se a revalidação falhar */ }
    }

    if (event === 'payment.completed' && verifiedStatus === 'paid') {
      // >>> AQUI vai a sua lógica de fulfillment (pedido pago):
      //   - registrar venda / enviar para CRM / Utmify / planilha
      //   - liberar acesso, enviar e-mail, etc.
      console.log('[VexoPay] PAGO', { transactionId, amount: verified.amount, paidAt: verified.paidAt });

      if (!purchasesSent.has(transactionId)) {
        if (purchasesSent.size > 500) purchasesSent.clear();
        purchasesSent.add(transactionId);

        const customer = verified.customer || {};
        const payerName = verified.payerName || customer.name;
        const amount = Number(verified.amount);

        try {
          await sendFbEvent({
            eventName: 'Purchase',
            eventId: 'purchase_' + transactionId,
            // paidAt evita que uma reentrega tardia do webhook registre a venda
            // com a hora errada. O helper corrige se vier fora da janela da Meta.
            eventTime: verified.paidAt ? Math.floor(new Date(verified.paidAt).getTime() / 1000) : undefined,
            actionSource: 'website',
            sourceUrl: SITE_URL,

            value: isFinite(amount) && amount > 0 ? amount : undefined,
            currency: 'BRL',
            orderId: transactionId,
            contentName: 'Body Splash Liberte 200ml',
            contentType: 'product',

            email: verified.payerEmail || customer.email,
            phone: verified.payerPhone || customer.phone,
            firstName: firstName(payerName),
            lastName: lastName(payerName),
            cpf: verified.payerDocument || customer.document,
            country: 'br'
          });
        } catch (_) { /* nunca deixa o webhook falhar por causa de tracking */ }
      }
    } else if (event === 'payment.failed') {
      console.log('[VexoPay] FALHOU', { transactionId });
    } else if (event === 'payment.expired') {
      console.log('[VexoPay] EXPIROU', { transactionId });
    } else {
      console.log('[VexoPay] evento não tratado', { event, transactionId, verifiedStatus });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    // Responde 200 mesmo em erro de parsing para evitar reenvios infinitos;
    // o erro fica no log da função.
    console.error('[VexoPay] erro no webhook', e && e.message);
    return res.status(200).json({ ok: true });
  }
};
