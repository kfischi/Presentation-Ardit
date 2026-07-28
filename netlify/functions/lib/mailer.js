'use strict'

const { withRetry, PermanentError } = require('./retry')
const { normalizePhone } = require('./phone')

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

// Brand palette — no other colours, no gradients, no images.
const C = {
  bg: '#FBF8FF',
  bgAlt: '#F3ECFD',
  text: '#1A0B2E',
  textSoft: '#66557E',
  violet: '#A06BFF',
  fuchsia: '#FF0090',
  line: '#E7DEF7',
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function send({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.FROM_EMAIL
  if (!apiKey) throw new PermanentError('RESEND_API_KEY is not configured')
  if (!from) throw new PermanentError('FROM_EMAIL is not configured')
  if (!to) throw new PermanentError('no recipient address')

  return withRetry(`resend:${subject}`, async () => {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, reply_to: replyTo }),
    })
    if (!res.ok) {
      const err = new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`)
      err.status = res.status
      throw err
    }
    return res.json()
  })
}

function shell(inner) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<body style="margin:0;padding:24px;background:${C.bg};font-family:'Heebo',system-ui,'Segoe UI',Arial,sans-serif;color:${C.text};">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid ${C.line};border-radius:16px;padding:32px;">
${inner}
  </div>
</body>
</html>`
}

function button(href, label) {
  return `<a href="${href}" style="display:inline-block;background:${C.fuchsia};color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:700;font-size:16px;">${label}</a>`
}

/** Wording is fixed by the spec — do not embellish. */
function customerEmail(name, link) {
  return shell(`
    <p style="font-size:17px;line-height:1.8;margin:0 0 16px;">היי ${escapeHtml(name)},</p>
    <p style="font-size:17px;line-height:1.8;margin:0 0 8px;">התשלום התקבל. המדריך התפעולי לשבת חתן מחכה לך כאן:</p>
    <p style="margin:0 0 24px;">${button(link, 'לפתיחת המדריך')}</p>
    <p style="font-size:15px;line-height:1.8;color:${C.textSoft};margin:0 0 24px;">הקישור אישי ושמור עבורך — אפשר לחזור אליו מתי שתרצה.</p>
    <p style="font-size:17px;line-height:1.8;margin:0;">בהצלחה,<br>Multibrawn</p>`)
}

async function sendGuideToCustomer({ name, email, link }) {
  return send({
    to: email,
    subject: 'המדריך התפעולי לשבת חתן — הקישור שלך',
    replyTo: process.env.ARDIT_EMAIL,
    html: customerEmail(name, link),
  })
}

/** The message Aradit's WhatsApp opens with, already filled in. */
function whatsappText(name, link) {
  return [
    `היי ${name}, מדברים מ-Multibrawn.`,
    'התשלום התקבל והמדריך התפעולי לשבת חתן מחכה לך כאן:',
    link,
    'הקישור אישי ושמור עבורך. בהצלחה!',
  ].join('\n')
}

function row(label, value) {
  return `<tr>
      <td style="padding:8px 0;color:${C.textSoft};font-size:14px;white-space:nowrap;">${label}</td>
      <td style="padding:8px 0 8px 16px;font-size:15px;font-weight:500;">${value}</td>
    </tr>`
}

async function sendAlertToAradit({ name, email, phone, amount, link }) {
  const to = process.env.ARDIT_EMAIL
  if (!to) throw new PermanentError('ARDIT_EMAIL is not configured')

  const normalized = normalizePhone(phone)
  const waBlock = normalized
    ? `<p style="margin:0 0 8px;">${button(
        `https://wa.me/${normalized}?text=${encodeURIComponent(whatsappText(name, link))}`,
        'שליחת המדריך בוואטסאפ'
      )}</p>
       <p style="font-size:13px;color:${C.textSoft};margin:0;">ההודעה תיפתח מוכנה — צריך רק ללחוץ שליחה.</p>`
    : `<p style="margin:0;padding:14px 16px;background:${C.bgAlt};border-radius:8px;font-size:15px;">
         מספר הטלפון שהתקבל אינו תקין (${escapeHtml(phone) || 'ריק'}) — לא ניתן ליצור קישור וואטסאפ. אפשר לפנות ללקוח במייל.
       </p>`

  return send({
    to,
    subject: `מכירה חדשה · ${name}`,
    replyTo: email || undefined,
    html: shell(`
    <h1 style="font-size:20px;font-weight:700;margin:0 0 20px;">מכירה חדשה</h1>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px;">
      ${row('שם', escapeHtml(name))}
      ${row('טלפון', escapeHtml(phone) || '—')}
      ${row('אימייל', escapeHtml(email) || '—')}
      ${row('סכום', `${escapeHtml(amount)} ₪`)}
    </table>
    <p style="font-size:14px;color:${C.textSoft};margin:0 0 6px;">הקישור האישי של הלקוח</p>
    <p style="margin:0 0 24px;font-size:13px;word-break:break-all;padding:12px 14px;background:${C.bgAlt};border-radius:8px;">
      <a href="${link}" style="color:${C.violet};text-decoration:none;">${escapeHtml(link)}</a>
    </p>
    ${waBlock}`),
  })
}

module.exports = { sendGuideToCustomer, sendAlertToAradit, whatsappText }
