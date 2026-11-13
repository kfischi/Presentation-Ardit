'use strict'

/**
 * Normalises an Israeli mobile number to bare international form: 972XXXXXXXXX.
 * Returns null for anything that is not a valid Israeli mobile, so callers can
 * skip building a WhatsApp link rather than producing a broken one.
 */
function normalizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null

  // Strip everything that is not a digit. This also drops the leading "+",
  // spaces, hyphens and parentheses in one pass.
  const digits = String(input).replace(/\D/g, '')
  if (!digits) return null

  // 05XXXXXXXX (local, 10 digits) -> 9725XXXXXXXX
  if (/^05\d{8}$/.test(digits)) return `972${digits.slice(1)}`

  // 9725XXXXXXXX (already international, 12 digits)
  if (/^9725\d{8}$/.test(digits)) return digits

  // 5XXXXXXXX (9 digits, leading zero already lost somewhere upstream)
  if (/^5\d{8}$/.test(digits)) return `972${digits}`

  // 009725XXXXXXXX (international dialling prefix)
  if (/^009725\d{8}$/.test(digits)) return digits.slice(2)

  return null
}

module.exports = { normalizePhone }
