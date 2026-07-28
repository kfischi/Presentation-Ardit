'use strict'

const crypto = require('crypto')

const TOKEN_LENGTH = 16

/**
 * Derives the personal access token for a transaction.
 * HMAC-SHA256(transaction_id, TOKEN_SECRET), base64url, first 16 characters.
 * Deterministic and stateless — the link never expires and nothing is stored.
 */
function createToken(transactionId, secret) {
  if (!secret) throw new Error('TOKEN_SECRET is not configured')
  if (!transactionId) throw new Error('transactionId is required')

  return crypto
    .createHmac('sha256', secret)
    .update(String(transactionId))
    .digest('base64url')
    .slice(0, TOKEN_LENGTH)
}

/**
 * Constant-time token comparison. A plain `===` leaks how many leading
 * characters were correct, which is enough to derive a token byte by byte.
 */
function verifyToken(transactionId, candidate, secret) {
  if (typeof candidate !== 'string' || candidate.length !== TOKEN_LENGTH) return false

  let expected
  try {
    expected = createToken(transactionId, secret)
  } catch {
    return false
  }

  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  // timingSafeEqual throws on unequal lengths, so the guard above is load-bearing.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function buildGuideLink(transactionId, secret, baseUrl) {
  const token = createToken(transactionId, secret)
  const root = (baseUrl || '').replace(/\/+$/, '')
  return `${root}/.netlify/functions/guide?id=${encodeURIComponent(transactionId)}&t=${token}`
}

module.exports = { createToken, verifyToken, buildGuideLink, TOKEN_LENGTH }
