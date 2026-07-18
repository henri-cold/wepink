// Vercel Serverless Function — consulta o status de uma cobrança PIX na VexoPay.

const VEXO_CI = process.env.VEXO_CI;
const VEXO_CS = process.env.VEXO_CS;
const BASE_URL = 'https://www.vexopay.com.br/api';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ success: false, error: 'Método não permitido' });
  }

  if (!VEXO_CI || !VEXO_CS) {
    return res.status(500).json({ success: false, error: 'Credenciais da VexoPay não configuradas no servidor (VEXO_CI/VEXO_CS).' });
  }

  try {
    const transactionId = (req.query && req.query.transactionId) || '';
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
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ success: false, error: 'Erro interno ao consultar status.' });
  }
};
