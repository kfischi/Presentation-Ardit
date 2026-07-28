'use strict'

const fs = require('fs')
const path = require('path')
const { verifyToken } = require('./lib/token')
const { transactionExists } = require('./lib/sheets')

const GUIDE_FILE = 'Guide.html'
const WHATSAPP = process.env.ARDIT_WHATSAPP || '972523983394'

// Read once per container rather than per request — the file never changes
// between deploys, and cold starts are the only cost worth paying.
let cachedGuide = null

function loadGuide() {
  if (cachedGuide === null) {
    cachedGuide = fs.readFileSync(path.join(__dirname, 'private', GUIDE_FILE), 'utf-8')
  }
  return cachedGuide
}

function deniedPage() {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>הקישור לא תקין · Multibrawn</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@500;700&family=Heebo:wght@400;500&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
       background:#FBF8FF;color:#1A0B2E;font-family:'Heebo',system-ui,Arial,sans-serif;}
  .card{background:#fff;border:1px solid #E7DEF7;border-radius:16px;padding:40px 32px;max-width:460px;text-align:center;}
  h1{font-family:'Frank Ruhl Libre',Georgia,serif;font-size:24px;font-weight:700;margin:0 0 12px;}
  p{color:#66557E;font-size:16px;line-height:1.8;margin:0 0 24px;}
  a{display:inline-block;background:#FF0090;color:#fff;text-decoration:none;
    padding:14px 28px;border-radius:8px;font-weight:500;}
</style>
</head>
<body>
  <div class="card">
    <h1>הקישור לא תקין</h1>
    <p>אם רכשת את המדריך ולא הצלחת להיכנס — דברו איתנו ונפתור את זה מיד.</p>
    <a href="https://wa.me/${WHATSAPP}">דברו איתנו בוואטסאפ</a>
  </div>
</body>
</html>`
}

/**
 * The thank-you page can only pass the transaction id — the token is an HMAC
 * and the secret must never reach the browser. So a link without `t` is
 * authorised against the sheet instead: only a transaction the webhook
 * actually recorded is served.
 *
 * The webhook writes the row after sending the emails, so a customer landing
 * on the thank-you page can briefly arrive first. One short retry covers that
 * window without making a legitimate buyer refresh.
 */
async function isRecordedSale(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (await transactionExists(id)) return true
    } catch (err) {
      console.error('[guide] sheet lookup failed', err.message)
      return false
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return false
}

exports.handler = async (event) => {
  const { id, t } = event.queryStringParameters || {}

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    // The guide is paid content — keep it out of search indexes and shared caches.
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'private, no-store',
  }

  if (!id) {
    return { statusCode: 403, headers, body: deniedPage() }
  }

  const authorised = t
    ? verifyToken(id, t, process.env.TOKEN_SECRET)
    : await isRecordedSale(id)

  if (!authorised) {
    return { statusCode: 403, headers, body: deniedPage() }
  }

  try {
    return { statusCode: 200, headers, body: loadGuide() }
  } catch (err) {
    console.error('[guide] could not read private/guide.html', err.message)
    return { statusCode: 500, headers, body: deniedPage() }
  }
}
