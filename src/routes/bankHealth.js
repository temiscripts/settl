'use strict';

const { Router } = require('express');
const { getBankHealth, getAllBankHealth } = require('../services/bankHealth');
const logger = require('../lib/logger');

const router = Router();

router.get('/bank-health', async (req, res) => {
  const banks = await getAllBankHealth();
  return res.status(200).json({ banks });
});

router.get('/bank-health/:bankCode', async (req, res) => {
  const { bankCode } = req.params;
  const data = await getBankHealth(bankCode);
  if (data.health_status === 'Unknown') {
    logger.warn({ bankCode }, 'bank health requested for unknown bank code');
    return res.status(404).json({ error: `No transaction data found for bank ${bankCode}` });
  }
  return res.status(200).json({ bankCode, ...data });
});

module.exports = router;
