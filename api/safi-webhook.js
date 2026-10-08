// Vercel Serverless Function — recebe os webhooks da SafiPay.
// Configure na SafiPay (painel → Webhooks) a URL:
//   https://wepink-flax.vercel.app/api/safi-webhook
//
// Eventos tratados: pix.paid | pixout.paid | pixout.failed
//
// IMPORTANTE: o corpo precisa chegar RAW para validar a assinatura HMAC-SHA256.
// Desligamos o bodyParser do Vercel nesta rota (ver config abaixo).

const crypto = require('crypto');
const { sendFbEvent, SITE_URL } = require('./_fbcapi');

const SAFI_CI = process.env.SAFIPAY_CI;
const SAFI_CS = process.env.SAFIPAY_CS;
const SAFI_SECRET = process.env.SAFIPAY_WEBHOOK_SECRET; // whsec_... (chave da rota) ou 64 hex (conta)

// Desliga o bodyParser do Vercel para esta rota — precisamos do corpo bruto.
module.exports.config = { api: { bodyParser: false } };

const purchasesSent = new Set();

function firstName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return parts[0] || undefined;
}

function lastName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : undefined;
}

/** Lê o body bruto como Buffer (necessário para validar HMAC sobre os bytes originais). */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Valida a assinatura V2 da SafiPay.
 *  Header: X-SafiPay-Signature-V2: t=<unix>,v1=<hex>
 *  Payload: HMAC-SHA256(segredo, t + "." + corpoBruto)
 */
function validateSignature(rawBody, header, secret) {
  if (!header || !secret) return false;

  // Monta { t: "...", v1: "..." }
  const parts = {};
  header.split(',').forEach((p) => {
    const idx = p.indexOf('=');
    if (idx > 0) parts[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
  });

  const t = Number(parts.t);
  const v1 = parts.v1 || '';
  if (!t) return false;

  // Janela de ±300 s para evitar replay.
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(String(t) + '.')
    .update(rawBody)
    .digest('hex');

  if (v1.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'Erro ao ler corpo.' });
  }

  // Valida assinatura ANTES de fazer JSON.parse (regra da documentação SafiPay).
  const sigHeader = req.headers['x-safipay-signature-v2'] || '';
  if (SAFI_SECRET) {
    if (!validateSignature(rawBody, sigHeader, SAFI_SECRET)) {
      console.warn('[safi-webhook] assinatura inválida', sigHeader.slice(0, 40));
      return res.status(401).json({ ok: false, error: 'Assinatura inválida.' });
    }
  } else {
    // Sem segredo configurado: aceita mas loga para alertar.
    console.warn('[safi-webhook] SAFIPAY_WEBHOOK_SECRET não configurado — validação ignorada!');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'JSON inválido.' });
  }

  const { event, data } = payload;
  const transactionId = data && data.transactionId;

  // Responde 200 imediatamente — a SafiPay exige resposta em até 10 s.
  // O trabalho pesado (rastreio Meta) roda depois.
  res.status(200).json({ ok: true });

  if (!transactionId) return;

  if (event === 'pix.paid') {
    // Chave de deduplicação: transactionId + event (uma execução por pagamento).
    const key = transactionId + ':pix.paid';
    if (purchasesSent.has(key)) return;
    if (purchasesSent.size > 500) purchasesSent.clear();
    purchasesSent.add(key);

    const amount = Number(data.amount);
    const payerName = data.payerName;

    console.log('[SafiPay] PAGO', { transactionId, amount, paidAt: data.paidAt });

    try {
      await sendFbEvent({
        eventName: 'Purchase',
        eventId: 'purchase_' + transactionId,
        // paidAt real evita que o webhook atrasado registre a venda com a hora errada.
        eventTime: data.paidAt ? Math.floor(new Date(data.paidAt).getTime() / 1000) : undefined,
        actionSource: 'website',
        sourceUrl: SITE_URL,

        value: isFinite(amount) && amount > 0 ? amount : undefined,
        currency: 'BRL',
        orderId: transactionId,
        contentName: 'Body Splash Liberte 200ml',
        contentType: 'product',

        email: undefined,    // webhook não traz e-mail/CPF sempre — preenche o que vier
        firstName: firstName(payerName),
        lastName: lastName(payerName),
        cpf: data.payerDocument,
        country: 'br'
      });
    } catch (_) { /* rastreio nunca pode quebrar o webhook */ }

  } else if (event === 'pixout.paid') {
    console.log('[SafiPay] REPASSE CONCLUÍDO', { transactionId });
  } else if (event === 'pixout.failed') {
    console.log('[SafiPay] REPASSE FALHOU', { transactionId });
  } else if (event === 'test.ping') {
    console.log('[SafiPay] ping de teste recebido');
  } else {
    console.log('[SafiPay] evento não tratado', { event, transactionId });
  }
};
