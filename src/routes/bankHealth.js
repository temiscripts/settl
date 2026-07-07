'use strict';

const { Router } = require('express');
const bankHealth = require('../services/bankHealth');

const router = Router();

router.get('/bank-health', async (req, res, next) => {
  try {
    const report = await bankHealth.getReport();
    return res.status(200).json(report);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
