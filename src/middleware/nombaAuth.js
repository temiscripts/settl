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
  if (!nombaSignature) {
    return res.status(401).json({ error: 'Missing signature header.' });
  }

  try {
    
    const rawStringBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

   
    const calculatedHmacRaw = crypto
      .createHmac('sha256', secret)
      .update(rawStringBody)
      .digest('base64');

    
    let parsedJson = {};
    try { 
      parsedJson = JSON.parse(rawStringBody); 
    } catch (e) {
     
    }
    
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
    const matrixMessage = `${hashingPayload}:${timestamp}`;
    
    const calculatedHmacMatrix = crypto
      .createHmac('sha256', secret)
      .update(matrixMessage)
      .digest('base64');

   
    console.log("\n🔍 --- TEAM WORKSPACE SIGNATURE DUEL ---");
    console.log("RECEIVED SIGNATURE :", nombaSignature);
    console.log("STRATEGY A (RAW)   :", calculatedHmacRaw);
    console.log("STRATEGY B (MATRIX):", calculatedHmacMatrix);
    console.log("------------------------------------------\n");

    const receivedBuffer = Buffer.from(nombaSignature, 'utf8');
    const bufRaw = Buffer.from(calculatedHmacRaw, 'utf8');
    const bufMatrix = Buffer.from(calculatedHmacMatrix, 'utf8');

   
    const passRaw = bufRaw.length === receivedBuffer.length && crypto.timingSafeEqual(bufRaw, receivedBuffer);
    const passMatrix = bufMatrix.length === receivedBuffer.length && crypto.timingSafeEqual(bufMatrix, receivedBuffer);

    if (!passRaw && !passMatrix) {
      console.log("⚠️ Webhook Blocked: Digital signatures mismatch.");
      return res.status(401).json({ error: 'Invalid HMAC signature.' });
    }

  
    req.parsedWebhookBody = parsedJson;
    next();
  } catch (error) {
    console.error("❌ Cryptographic process failure:", error.message);
    return res.status(500).json({ error: 'Security Layer Error' });
  }
}

module.exports = verifyNombaSignature;
