'use strict'

const crypto = require('crypto')
const { buildGuideLink } = require('./lib/token')
const { normalizePhone } = require('./lib/phone')
const { hebrewReason, withDeadline } = require('./lib/retry')
const { sendGuideToCustomer, sendAlertToAradit } = require('./lib/mailer')
const { transactionExists, appendSale } = require('./lib/sheets')

/**
 * TODO(kfir): confirm against a real GROW payload. Each entry lists the field
 * names we accept, in priority order — extending it is a one-line change once
 * we have a sample. The raw payload is logged on every call (see readPayload)
 * precisely so this map can be corrected without guessing.
 */
const FIELD_MAP = {
  transactionId: ['transaction_id', 'transactionId', 'transactionToken', 'asmachta', 'id'],
  name: ['customer_name', 'customerName', 'fullName', 'full_name', 'payerName', 'first_name'],
  email: ['customer_email', 'customerEmail', 'email', 'payerEmail'],
  phone: ['customer_phone', 'customerPhone', 'phone', 'payerPhone', 'cellphone'],
  amount: ['amount', 'sum', 'total', 'paymentSum'],
}

/** TODO(kfir): confirm which header GROW signs with. */
const SIGNATURE_HEADERS = ['x-grow-signature', 'x-signature', 'x-hub-signature-256', 'signature']

function pick(payload, candidates) {
  for (const key of candidates) {
    if (payload[key] !== undefined && payload[key] !== null && String(payload[key]).trim() !== '') {
      return String(payload[key]).trim()
    }
  }
  return ''
}

/** GROW may post form-encoded or JSON; accept both. */
function readPayload(event) {
  const raw = event.body || ''
  const contentType = (event.headers['content-type'] || '').toLowerCase()

  let parsed = {}
  try {
    if (contentType.includes('application/json')) {
      parsed = JSON.parse(raw)
    } else {
      parsed = Object.fromEntries(new URLSearchParams(raw))
    }
  } catch (err) {
    console.error('[grow-webhook] could not parse body', err.message)
  }

  // Logged so the field map above can be corrected from a real transaction.
  console.log('[grow-webhook] raw payload', JSON.stringify(parsed))

  // GROW nests the useful fields under `data` on some page types.
  const flat = { ...parsed, ...(parsed.data && typeof parsed.data === 'object' ? parsed.data : {}) }

  return {
    raw,
    fields: {
      transactionId: pick(flat, FIELD_MAP.transactionId),
      name: pick(flat, FIELD_MAP.name),
      email: pick(flat, FIELD_MAP.email),
      phone: pick(flat, FIELD_MAP.phone),
      amount: pick(flat, FIELD_MAP.amount),
    },
  }
}

/**
 * Verifies the request really came from GROW.
 * If the secret is not configured we log loudly and continue — per spec §3 a
 * missing variable must not crash the function. Once the secret is set, a bad
 * signature is rejected outright.
 */
function verifySignature(event, raw) {
  const secret = process.env.GROW_WEBHOOK_SECRET
  if (!secret) {
    console.error('[grow-webhook] GROW_WEBHOOK_SECRET is not configured — accepting unverified request')
    return true
  }

  const header = SIGNATURE_HEADERS.map((h) => event.headers[h]).find(Boolean)
  if (!header) {
    console.error('[grow-webhook] no signature header present', Object.keys(event.headers).join(','))
    return false
  }

  // Strip a "sha256=" prefix if GROW uses the GitHub-style format.
  const provided = header.includes('=') ? header.split('=').pop().trim() : header.trim()

  // Accept hex or base64 — TODO(kfir): pin to whichever GROW actually sends.
  // A fresh Hmac per encoding: unlike Hash, Hmac cannot be copied.
  for (const encoding of ['hex', 'base64']) {
    const expected = crypto.createHmac('sha256', secret).update(raw).digest(encoding)
    const a = Buffer.from(expected)
    const b = Buffer.from(provided)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
  }

  console.error('[grow-webhook] signature mismatch')
  return false
}

// Netlify kills a synchronous function at 10s. Retries across the lookup, the
// two sends and the append share this budget, leaving headroom to still write
// the outcome row and answer GROW.
const BUDGET_MS = 7500

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  return withDeadline(BUDGET_MS, () => handlePayment(event))
}

async function handlePayment(event) {
  try {
    const { raw, fields } = readPayload(event)

    // 5.1 — authenticate before anything else.
    if (!verifySignature(event, raw)) {
      return { statusCode: 401, body: 'invalid signature' }
    }

    if (!fields.transactionId) {
      console.error('[grow-webhook] payload has no transaction id — check FIELD_MAP')
      return { statusCode: 400, body: 'missing transaction id' }
    }

    // 5.2 — GROW retries; never deliver twice.
    try {
      if (await transactionExists(fields.transactionId)) {
        console.log(`[grow-webhook] ${fields.transactionId} already recorded, skipping`)
        return { statusCode: 200, body: 'duplicate' }
      }
    } catch (err) {
      // A lookup failure must not block a real sale. Worst case is a duplicate
      // email, which is far better than a paying customer receiving nothing.
      console.error('[grow-webhook] duplicate check failed, continuing', err.message)
    }

    // 5.3 — personal, permanent link.
    const link = buildGuideLink(
      fields.transactionId,
      process.env.TOKEN_SECRET,
      process.env.URL || process.env.SITE_URL || 'https://guide.multibrawn.co.il'
    )

    const name = fields.name || 'לקוח יקר'

    // 5.4 — both sends are independent; one failing must not affect the other.
    const [customerResult, araditResult] = await Promise.allSettled([
      sendGuideToCustomer({ name, email: fields.email, link }),
      sendAlertToAradit({
        name,
        email: fields.email,
        phone: fields.phone,
        amount: fields.amount,
        link,
      }),
    ])

    const describe = (result) =>
      result.status === 'fulfilled' ? 'נשלח' : `נכשל: ${hebrewReason(result.reason)}`

    if (customerResult.status === 'rejected') {
      console.error('[grow-webhook] customer email failed', customerResult.reason)
    }
    if (araditResult.status === 'rejected') {
      console.error('[grow-webhook] aradit alert failed', araditResult.reason)
    }

    // 5.5 — one write, after the sends, and never fatal.
    try {
      await appendSale({
        timestamp: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }),
        transactionId: fields.transactionId,
        name,
        email: fields.email,
        phone: normalizePhone(fields.phone) || fields.phone || '',
        amount: fields.amount,
        link,
        customerEmailStatus: describe(customerResult),
        araditAlertStatus: describe(araditResult),
      })
    } catch (err) {
      console.error('[grow-webhook] sheet write failed', err.message)
    }

    // 5.6 — the payment is real; never hand GROW a reason to retry.
    return { statusCode: 200, body: 'ok' }
  } catch (err) {
    console.error('[grow-webhook] unexpected failure', err)
    // Reached only before the payment was acknowledged, so a retry is safe.
    return { statusCode: 500, body: 'error' }
  }
}
