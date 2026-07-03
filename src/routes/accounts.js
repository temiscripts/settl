'use strict';

const { Router } = require('express');
const { z } = require('zod');
const provisioning = require('../services/provisioning');
const logger = require('../lib/logger');

const router = Router();

const createAccountSchema = z.object({
  customerName: z.string().min(1).max(100),
  accountRef: z.string().min(1).max(100),
  expectedAmount: z.number().int().positive().optional(),
  expiryDate: z.string().datetime().optional(),
});

router.post('/accounts', async (req, res, next) => {
  const result = createAccountSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
  }
  try {
    const account = await provisioning.createAccount(result.data);
    logger.info({ requestId: req.requestId, accountId: account.id }, 'account created');
    return res.status(201).json({ account });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'accountRef already exists' });
    }
    next(err);
  }
});

router.get('/accounts/:id', async (req, res, next) => {
  try {
    const account = await provisioning.getAccount(req.params.id);
    return res.status(200).json({ account });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.get('/accounts/:id/balance', async (req, res, next) => {
  try {
    const balance = await provisioning.getBalance(req.params.id);
    return res.status(200).json(balance);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

router.get('/accounts/:id/transactions', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const result = await provisioning.getTransactions(req.params.id, { page, limit });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
