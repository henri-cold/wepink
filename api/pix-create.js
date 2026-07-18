// Vercel Serverless Function — cria uma cobrança PIX real na VexoPay.
// As credenciais ficam SOMENTE no servidor via Environment Variables (nunca no código/navegador).
// Configure na Vercel: Settings > Environment Variables > VEXO_CI e VEXO_CS.

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

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Erro interno ao gerar o PIX.' });
  }
};
