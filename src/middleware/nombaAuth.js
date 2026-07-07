'use strict';

const crypto = require('crypto');

function verifyNombaSignature(req, res, next) {
  const nombaSignature = req.headers['nomba-signature'] || req.headers['nomba-sig-value'];
  const timestamp = req.headers['nomba-timestamp']; 
  const secret = process.env.NOMBA_WEBHOOK_SECRET;

  if (!secret) {
    console.error("❌ Configuration Error: NOMBA_WEBHOOK_SECRET is missing in environment variables.");
    return res.status(500).json({ error: 'Missing security configuration.' });
  }
  if (!nombaSignature || !timestamp) {
    return res.status(401).json({ error: 'Missing signature or timestamp headers.' });
  }

  try {
    // req.body is a raw Buffer because of express.raw() in the route
    const rawStringBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

    let parsedJson = {};
    try { 
      parsedJson = JSON.parse(rawStringBody); 
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }
    
    // Build the hashing payload exactly as Nomba signs it (Colon-Matrix)
    const hashingPayload = [
      parsedJson.event_type || parsedJson.event || '',
      parsedJson.requestId || '',
      parsedJson.data?.merchant?.userId || '',
      parsedJson.data?.merchant?.walletId || '',
      parsedJson.data?.transaction?.transactionId || '',
      parsedJson.data?.transaction?.type || '',
      parsedJson.data?.transaction?.time || '',
      parsedJson.data?.transaction?.responseCode || ''
    ].join(':');
    
    const message = `${hashingPayload}:${timestamp}`;
    
    const calculatedHmac = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('base64');

    const receivedBuffer = Buffer.from(nombaSignature, 'utf8');
    const trustedBuffer = Buffer.from(calculatedHmac, 'utf8');

    // Constant-time comparison to prevent timing attacks
    if (trustedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(trustedBuffer, receivedBuffer)) {
      console.log("⚠️ Webhook Blocked: Invalid HMAC signature.");
      return res.status(401).json({ error: 'Invalid HMAC signature.' });
    }

    // Attach parsed JSON down the line so the route handler doesn't have to parse it twice
    req.parsedWebhookBody = parsedJson;
    next();
  } catch (error) {
    console.error("❌ Cryptographic process failure:", error.message);
    return res.status(500).json({ error: 'Security Layer Error' });
  }
}

module.exports = verifyNombaSignature;
