'use strict'

const crypto = require('crypto')
const { withRetry } = require('./retry')

const SHEET_TAB = 'מכירות'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Signs a service-account JWT and exchanges it for an access token.
 * Done by hand rather than via `googleapis` — that package pulls tens of
 * megabytes into the function bundle and slows every cold start, for two
 * REST calls we can make directly.
 */
async function getAccessToken() {
  const email = process.env.GOOGLE_SA_EMAIL
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY
  if (!email || !rawKey) {
    throw new Error('GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY are not configured')
  }

  // Netlify stores the key with literal "\n" sequences; PEM needs real newlines.
  const privateKey = rawKey.replace(/\\n/g, '\n')

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const signingInput = `${encode(header)}.${encode(claims)}`
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey, 'base64url')
  const assertion = `${signingInput}.${signature}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  if (!res.ok) {
    const err = new Error(`Google token exchange failed: ${await res.text()}`)
    err.status = res.status
    throw err
  }

  const body = await res.json()
  return body.access_token
}

async function sheetsFetch(path, options = {}) {
  const sheetId = process.env.SHEET_ID
  if (!sheetId) throw new Error('SHEET_ID is not configured')

  const token = await getAccessToken()
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  if (!res.ok) {
    const err = new Error(`Sheets API ${res.status}: ${await res.text()}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * Column B holds the transaction id. GROW retries webhooks, so this is the
 * guard that stops a customer receiving the guide twice.
 *
 * Deliberately not retried. Netlify gives the function ten seconds in total,
 * and the two email sends plus the row append already claim most of it. A
 * failed lookup here is recoverable — the caller continues and the worst case
 * is one duplicate email — whereas spending seven seconds on retries can time
 * the whole function out, which makes GROW redeliver and causes the very
 * duplicate this check exists to prevent.
 */
async function transactionExists(transactionId) {
  const range = encodeURIComponent(`${SHEET_TAB}!B:B`)
  const data = await sheetsFetch(`/values/${range}`)
  const rows = data.values || []
  return rows.some((row) => row[0] && String(row[0]).trim() === String(transactionId).trim())
}

/** Appends one row, columns A-J, in the order fixed by the spec. */
async function appendSale(sale) {
  const range = encodeURIComponent(`${SHEET_TAB}!A:J`)
  const row = [
    sale.timestamp,
    sale.transactionId,
    sale.name,
    sale.email,
    sale.phone,
    sale.amount,
    sale.link,
    sale.customerEmailStatus,
    sale.araditAlertStatus,
    '', // J — Aradit ticks this by hand once WhatsApp is sent
  ]

  await withRetry('sheets:append', () =>
    sheetsFetch(
      `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: [row] }) }
    )
  )
}

module.exports = { transactionExists, appendSale, SHEET_TAB }
