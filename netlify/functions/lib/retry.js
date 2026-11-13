'use strict'

const { AsyncLocalStorage } = require('async_hooks')

const DELAYS_MS = [1000, 2000, 4000]

// Netlify kills a synchronous function at 10 seconds. Retries are spread over
// several independent calls (lookup, two sends, append), so each one has to
// know how much of the shared budget is left rather than assuming it owns all
// of it. AsyncLocalStorage keeps that per-invocation instead of module-global,
// so concurrent invocations in a reused container cannot corrupt each other.
const deadlineStore = new AsyncLocalStorage()

/** Runs fn with a wall-clock budget that every nested withRetry respects. */
function withDeadline(totalMs, fn) {
  return deadlineStore.run({ at: Date.now() + totalMs }, fn)
}

function msRemaining() {
  const store = deadlineStore.getStore()
  return store ? store.at - Date.now() : Infinity
}

/** Marks an error as permanent so withRetry stops immediately. */
class PermanentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermanentError'
    this.permanent = true
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retries only what is worth retrying: 5xx, 429 and network failures.
 * A 4xx, a missing key or a malformed address fails identically on every
 * attempt, so retrying it only delays the error reaching the sheet.
 */
function isTransient(err) {
  if (!err || err.permanent) return false

  // A missing environment variable or a malformed argument fails identically on
  // every attempt. Retrying it burns the function's 10s budget for nothing —
  // and in the webhook that lost time can push GROW into a retry, which is the
  // duplicate delivery the whole flow exists to prevent.
  if (/not configured|is required|no recipient|no email/i.test(err.message || '')) return false

  const status = err.status
  if (typeof status === 'number') return status === 429 || status >= 500
  // No HTTP status at all means the request never completed — treat as network.
  return true
}

async function withRetry(label, fn) {
  let lastError
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isTransient(err) || attempt === DELAYS_MS.length) break

      const delay = DELAYS_MS[attempt]
      // Stop if sleeping and retrying would not leave room for the attempt
      // itself. Timing the function out is worse than failing early: the
      // failure gets recorded, a timeout makes GROW redeliver.
      if (msRemaining() < delay + 1500) {
        console.warn(`[retry] ${label} giving up — ${msRemaining()}ms of budget left`)
        break
      }

      console.warn(`[retry] ${label} attempt ${attempt + 1} failed (${err.message}); retrying in ${delay}ms`)
      await sleep(delay)
    }
  }
  throw lastError
}

/**
 * Turns any thrown error into the short Hebrew phrase written to the sheet.
 * Aradit reads this column, so it must never contain "Error 422".
 */
function hebrewReason(err) {
  if (!err) return 'שגיאה לא ידועה'
  if (err.hebrew) return err.hebrew

  const status = err.status
  if (status === 401 || status === 403) return 'מפתח API לא תקין'
  if (status === 422) return 'כתובת מייל לא תקינה'
  if (status === 429) return 'חריגה ממכסת השליחה'
  if (typeof status === 'number' && status >= 500) return 'שירות השליחה לא זמין'
  if (/not configured|לא מוגדר/i.test(err.message)) return 'הגדרה חסרה בשרת'
  if (/invalid email|no email/i.test(err.message)) return 'כתובת מייל לא תקינה'
  return 'שגיאת רשת'
}

module.exports = { withRetry, withDeadline, isTransient, hebrewReason, PermanentError }
