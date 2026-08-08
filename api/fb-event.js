// Rota que recebe eventos do navegador e reenvia pela Conversions API (server-side).
// Usada para InitiateCheckout (gerar QR) e, como redundância, Purchase.
// A deduplicação com o Pixel do navegador é feita pelo mesmo event_id.

const { sendFbEvent } = require('./_fbcapi');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método não permitido' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const allowed = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase'];
    if (!allowed.includes(body.eventName)) {
      return res.status(400).json({ ok: false, error: 'eventName inválido' });
    }

    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || undefined;

    const result = await sendFbEvent({
      eventName: body.eventName,
      eventId: body.eventId,
      value: typeof body.value === 'number' ? body.value : Number(body.value),
      currency: body.currency || 'BRL',
      orderId: body.transactionId,
      contentName: body.content_name,
      contentType: body.content_type,
      externalId: body.cpf,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      fbp: body.fbp,
      fbc: body.fbc,
      ip: ip,
      userAgent: req.headers['user-agent'],
      sourceUrl: body.sourceUrl,
      actionSource: 'website'
    });

    return res.status(200).json({ ok: true, capi: result.ok });
  } catch (e) {
    // Nunca quebra o checkout por causa de tracking.
    return res.status(200).json({ ok: false });
  }
};
