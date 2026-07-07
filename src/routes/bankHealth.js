'use strict';

const { Router } = require('express');
const { getReport, getBankByCode } = require('../services/bankHealth');
const logger = require('../lib/logger');

const router = Router();

router.get('/bank-health', async (req, res, next) => {
  try {
    const report = await getReport();
    return res.status(200).json(report);
  } catch (err) {
    next(err);
  }
});

router.get('/bank-health/:bankCode', async (req, res, next) => {
  try {
    const { bankCode } = req.params;
    const data = await getBankByCode(bankCode);
    if (!data) {
      logger.warn({ bankCode }, 'bank health requested for unknown bank code');
      return res.status(404).json({ error: `No transaction data found for bank ${bankCode}` });
    }
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
