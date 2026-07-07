'use strict';

const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');
const { verifyAuditChain } = require('../services/auditLog');

const router = Router();
const prisma = new PrismaClient();

router.get('/audit-log', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const rows = await prisma.auditLog.findMany({
      orderBy: { sequenceNumber: 'desc' },
      take: limit,
    });
    // payload is stored as the raw string that was hashed; parse it back
    // to JSON for API consumers (falls back to the raw string if it was
    // ever written as non-JSON).
    const entries = rows.map((row) => {
      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = row.payload;
      }
      return { ...row, payload };
    });
    return res.status(200).json({ entries });
  } catch (err) {
    next(err);
  }
});

router.get('/audit-log/verify', async (req, res, next) => {
  try {
    const [result, checked] = await Promise.all([
      verifyAuditChain(prisma),
      prisma.auditLog.count(),
    ]);
    return res.status(200).json({ ...result, checked });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
