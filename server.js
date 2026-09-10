const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;
const AMOUNT_CENTS = 5990;
const PAGARME_URL = 'https://api.pagar.me/core/v5/orders';

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname)));

function onlyDigits(value = '') {
  return String(value).replace(/\D/g, '');
}

function text(value = '', max = 120) {
  return String(value).trim().replace(/[<>]/g, '').slice(0, max);
}

function validateCustomer(input = {}) {
  const customer = {
    name: text(input.name),
    email: text(input.email, 160).toLowerCase(),
    document: onlyDigits(input.cpf),
    type: 'individual',
    address: {
      line_1: [text(input.address), text(input.number, 20)].filter(Boolean).join(', '),
      line_2: text(input.complement),
      zip_code: onlyDigits(input.zipCode),
      city: text(input.city, 80),
      state: text(input.state, 2).toUpperCase(),
      country: 'BR'
    }
  };

  const errors = [];
  if (customer.name.length < 3) errors.push('nome');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) errors.push('e-mail');
  if (![11, 14].includes(customer.document.length)) errors.push('CPF/CNPJ');
  if (customer.address.line_1.length < 3) errors.push('endereço');
  if (customer.address.zip_code.length !== 8) errors.push('CEP');
  if (customer.address.city.length < 2) errors.push('cidade');
  if (!/^[A-Z]{2}$/.test(customer.address.state)) errors.push('estado');
  if (errors.length) {
    const error = new Error(`Dados inválidos: ${errors.join(', ')}.`);
    error.status = 400;
    throw error;
  }
  if (customer.document.length === 14) customer.document_type = 'CNPJ';
  else customer.document_type = 'CPF';
  return customer;
}

function getDueDate() {
  const due = new Date();
  due.setUTCDate(due.getUTCDate() + 3);
  due.setUTCHours(23, 59, 59, 0);
  return due.toISOString();
}

function extractBoleto(order) {
  const charge = order?.charges?.[0];
  const transaction = charge?.last_transaction || {};
  return {
    order_id: order?.id,
    charge_id: charge?.id,
    status: charge?.status || order?.status,
    line: transaction.line || '',
    barcode: transaction.barcode || '',
    pdf_url: transaction.pdf || '',
    url: transaction.url || '',
    due_at: transaction.due_at || ''
  };
}

app.post('/api/gerar-boleto', async (req, res) => {
  if (!process.env.PAGARME_SECRET_KEY) {
    return res.status(500).json({ message: 'PAGARME_SECRET_KEY não configurada no servidor.' });
  }

  try {
    const customer = validateCustomer(req.body?.customer);
    const payload = {
      items: [{ amount: AMOUNT_CENTS, description: 'Cobrança de serviço', quantity: 1 }],
      customer,
      payments: [{
        payment_method: 'boleto',
        boleto: {
          instructions: 'Pagar até o vencimento.',
          due_at: getDueDate(),
          document_number: `BOL-${Date.now().toString().slice(-10)}`,
          type: 'DM'
        }
      }]
    };

    const auth = Buffer.from(`${process.env.PAGARME_SECRET_KEY}:`).toString('base64');
    const response = await fetch(PAGARME_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error('Pagar.me retornou erro HTTP', response.status);
      return res.status(502).json({ message: 'A Pagar.me não conseguiu emitir o boleto.' });
    }

    return res.status(201).json({ boleto: extractBoleto(result) });
  } catch (error) {
    console.error('Falha ao emitir boleto:', error.message);
    return res.status(error.status || 500).json({ message: error.message || 'Erro interno.' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
