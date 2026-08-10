// Vercel Serverless Function — cria uma cobrança PIX real na VexoPay.
// As credenciais ficam SOMENTE no servidor via Environment Variables (nunca no código/navegador).
// Configure na Vercel: Settings > Environment Variables > VEXO_CI e VEXO_CS.

const { sendFbEvent, requestContext, SITE_URL } = require('./_fbcapi');

const VEXO_CI = process.env.VEXO_CI;
const VEXO_CS = process.env.VEXO_CS;
const BASE_URL = 'https://www.vexopay.com.br/api';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  if (!VEXO_CI || !VEXO_CS) {
    return res.status(500).json({ success: false, error: 'Credenciais da VexoPay não configuradas no servidor (VEXO_CI/VEXO_CS).' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const amount = Number(body.amount);
    const payerName = (body.payerName || '').toString().trim();
    const payerDocument = (body.payerDocument || '').toString().replace(/\D/g, '');
    const description = (body.description || 'Pagamento Wepink').toString();

    if (!amount || amount < 2) return res.status(400).json({ success: false, error: 'Valor inválido (mínimo R$ 2,00).' });
    if (payerName.length < 3) return res.status(400).json({ success: false, error: 'Nome do pagador inválido.' });
    if (payerDocument.length !== 11) return res.status(400).json({ success: false, error: 'CPF inválido.' });

    const vexoRes = await fetch(BASE_URL + '/gateway/pix-create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ci': VEXO_CI,
        'cs': VEXO_CS
      },
      body: JSON.stringify({ amount, payerName, payerDocument, description })
    });

    const data = await vexoRes.json().catch(() => ({}));

    if (!vexoRes.ok) {
      return res.status(vexoRes.status).json({
        success: false,
        error: (data && (data.error || data.message)) || 'Erro ao gerar PIX na VexoPay.'
      });
    }

    // AddPaymentInfo disparado no SERVIDOR (QR gerado). Esta rota é chamada
    // direto pelo checkout, com nome neutro, então o adblock não bloqueia —
    // ao contrário do rastreio do navegador. Mesmo event_id do Pixel/wpk.js
    // ('addpaymentinfo_<txid>') para a Meta deduplicar quando os dois dispararem.
    const tx = data && data.data && data.data.transactionId;
    if (tx) {
      const t = (body && body.tracking) || {};
      const ctx = requestContext(req);
      const np = String(t.name || payerName || '').trim().split(/\s+/);
      try {
        await sendFbEvent({
          eventName: 'AddPaymentInfo',
          eventId: 'addpaymentinfo_' + tx,
          actionSource: 'website',
          sourceUrl: t.sourceUrl || (req.headers && req.headers.referer) || SITE_URL,
          value: amount,
          currency: 'BRL',
          orderId: tx,
          contentName: t.content_name || 'Body Splash Liberte 200ml',
          contentType: 'product',
          contentId: t.content_id,
          email: t.email,
          cpf: t.cpf || payerDocument,
          zip: t.cep,
          firstName: np[0] || undefined,
          lastName: np.length > 1 ? np.slice(1).join(' ') : undefined,
          country: t.country || ctx.country,
          anonId: t.anonId,
          fbp: t.fbp,
          fbc: t.fbc,
          fbclid: t.fbclid,
          ip: ctx.ip,
          userAgent: ctx.userAgent
        });
      } catch (_) { /* rastreio nunca pode quebrar a geração do PIX */ }
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Erro interno ao gerar o PIX.' });
  }
};
