// Vercel Serverless Function — cria uma cobrança PIX na SafiPay.
// Credenciais ficam SOMENTE no servidor via Environment Variables.
// Configure na Vercel: Settings > Environment Variables > SAFIPAY_CLIENT_ID e SAFIPAY_CLIENT_SECRET.

const { sendFbEvent, requestContext, SITE_URL } = require('./_fbcapi');

const SAFI_CI = process.env.SAFIPAY_CLIENT_ID;
const SAFI_CS = process.env.SAFIPAY_CLIENT_SECRET;
const BASE_URL = 'https://www.safipaybr.com';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  if (!SAFI_CI || !SAFI_CS) {
    return res.status(500).json({ success: false, error: 'Credenciais da SafiPay não configuradas (SAFIPAY_CI/SAFIPAY_CS).' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const amount = Number(body.amount);
    const payerName = String(body.payerName || '').trim();
    const payerDocument = String(body.payerDocument || '').replace(/\D/g, '');
    const description = String(body.description || 'Pagamento Wepink');
    // externalReference é o ID do pedido — usado como Idempotency-Key também.
    const externalReference = String(body.externalReference || '');

    if (!amount || amount < 1) return res.status(400).json({ success: false, error: 'Valor inválido (mínimo R$ 1,00).' });
    if (payerName.length < 3) return res.status(400).json({ success: false, error: 'Nome do pagador inválido.' });
    // payerDocument é opcional na SafiPay — só envia se parecer CPF/CNPJ válido em comprimento.
    const docValid = payerDocument.length === 11 || payerDocument.length === 14;

    // Idempotency-Key: só letras, números, ":", "_" e "-" (sem ponto).
    // Converte o valor para centavos inteiros para evitar ponto decimal.
    const amountCents = Math.round(amount * 100);
    const idempotencyKey = externalReference ||
      'wepink-' + (payerDocument.slice(-4) || '0000') + '-' + amountCents + '-' + Math.floor(Date.now() / 60000);

    const safiRes = await fetch(BASE_URL + '/api/gateway/pix-create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ci': SAFI_CI,
        'cs': SAFI_CS,
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        amount,
        description: description.slice(0, 180),
        payerName: payerName.slice(0, 120),
        payerDocument: docValid ? payerDocument : undefined,
        externalReference: externalReference.slice(0, 120) || undefined
      })
    });

    const data = await safiRes.json().catch(() => ({}));

    if (!safiRes.ok) {
      // AMOUNT_BELOW_MINIMUM traz o campo minAmount — repassar para o front tratar.
      return res.status(safiRes.status).json({
        success: false,
        error: (data && (data.error || data.message)) || 'Erro ao gerar PIX na SafiPay.',
        code: data && data.code,
        minAmount: data && data.minAmount
      });
    }

    // AddPaymentInfo no servidor — mesmo event_id que o wpk.js vai disparar no navegador.
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
