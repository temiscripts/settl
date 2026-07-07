'use strict';

const { Router } = require('express');
const { PrismaClient } = require('@prisma/client');

const router = Router();
const prisma = new PrismaClient();

const STATES = ['initiated', 'pending', 'settled', 'failed', 'reversing', 'reversed'];

// Global transaction feed + live summary, across all accounts — the data
// source for the ops dashboard (no per-account scoping, unlike
// GET /accounts/:id/transactions).
router.get('/transactions', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const where = req.query.state ? { state: req.query.state } : {};

    const [transactions, total, stateCounts, matchCounts] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
      prisma.transaction.groupBy({ by: ['state'], _count: { _all: true } }),
      prisma.transaction.groupBy({ by: ['settlementMatch'], _count: { _all: true } }),
    ]);

    const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const row of stateCounts) byState[row.state] = row._count._all;

    const byMatch = { exact: 0, overpaid: 0, underpaid: 0, none: 0 };
    for (const row of matchCounts) {
      const key = row.settlementMatch ?? 'none';
      byMatch[key] = (byMatch[key] ?? 0) + row._count._all;
    }

    return res.status(200).json({
      transactions,
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
      summary: { total, byState, byMatch },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
