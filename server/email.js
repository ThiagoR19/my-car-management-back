import nodemailer from 'nodemailer'
import { getExpirations, parseDate } from './domain.js'

export const frequencies = ['Mensual (día programado)', 'Quincenal (días 1 y 15)', 'Semanal (cada lunes)', 'Fecha puntual única']
const emailPattern = /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+\.[^\s@<>,;\r\n]+$/
const invalid = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }) }

export function zonedClock(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(({ type, value }) => [type, value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

export function emailConfig(settings, now = new Date()) {
  return { active: false, triggerDate: zonedClock(now, settings.timezone || 'America/Argentina/Buenos_Aires').date, triggerTime: '08:00', triggerFrequency: frequencies[0], recipients: [], subject: 'Vencimientos de la flota: mes actual y próximo', notes: 'Detalle de la documentación que requiere seguimiento.', ...(settings.emailAlerts || {}) }
}

export function validateEmailConfig(input, previous) {
  if (typeof input.active !== 'boolean') invalid('El estado del envío no es válido')
  if (!parseDate(input.triggerDate)) invalid('La fecha de inicio no es válida')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.triggerTime)) invalid('La hora de envío no es válida')
  if (!frequencies.includes(input.triggerFrequency)) invalid('La frecuencia no es válida')
  if (!Array.isArray(input.recipients) || input.recipients.length > 50 || input.recipients.some((value) => typeof value !== 'string' || !emailPattern.test(value.trim()))) invalid('Ingresá hasta 50 destinatarios válidos')
  const recipients = [...new Set(input.recipients.map((value) => value.trim().toLowerCase()))]
  if (input.active && !recipients.length) invalid('Añadí al menos un destinatario para activar los envíos')
  const subject = String(input.subject || '').trim()
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) invalid('El asunto debe tener entre 1 y 200 caracteres y una sola línea')
  const notes = String(input.notes || '').trim()
  if (notes.length > 5000) invalid('El mensaje no puede superar los 5000 caracteres')
  return { ...previous, active: input.active, triggerDate: input.triggerDate, triggerTime: input.triggerTime, triggerFrequency: input.triggerFrequency, recipients, subject, notes }
}

// Se toma la última ocurrencia debida para recuperar un envío tras reiniciar la API.
// Los días 29–31 se ajustan al último día de los meses más cortos.
export function scheduledKey(config, timezone, now = new Date()) {
  if (!config.active || !config.recipients.length) return null
  const clock = zonedClock(now, timezone)
  let current = new Date(`${clock.date}T12:00:00Z`)
  if (clock.time < config.triggerTime) current.setUTCDate(current.getUTCDate() - 1)
  const iso = (date) => date.toISOString().slice(0, 10)
  let due = config.triggerDate
  if (config.triggerFrequency === frequencies[0]) {
    const day = Number(config.triggerDate.slice(8))
    const candidate = (year, month) => new Date(Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()), 12))
    let date = candidate(current.getUTCFullYear(), current.getUTCMonth())
    if (date > current) date = candidate(current.getUTCFullYear(), current.getUTCMonth() - 1)
    due = iso(date)
  } else if (config.triggerFrequency === frequencies[1]) {
    current.setUTCDate(current.getUTCDate() >= 15 ? 15 : 1)
    due = iso(current)
  } else if (config.triggerFrequency === frequencies[2]) {
    current.setUTCDate(current.getUTCDate() - ((current.getUTCDay() + 6) % 7))
    due = iso(current)
  }
  if (due < config.triggerDate || due > iso(current)) return null
  return `${due}T${config.triggerTime}`
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))

export function buildEmailReport(store, config, now = new Date()) {
  const timezone = store.settings.timezone || 'America/Argentina/Buenos_Aires'
  const clock = zonedClock(now, timezone)
  // domain.js calcula días de calendario usando la fecha local de esta referencia.
  const date = new Date(`${clock.date}T12:00:00`)
  const overdue = getExpirations(store, { scope: 'overdue' }, date)
  const thisMonth = getExpirations(store, { scope: 'this-month' }, date).filter((item) => item.daysRemaining >= 0)
  const nextMonth = getExpirations(store, { scope: 'next-month' }, date)
  const sections = [{ title: 'Documentos vencidos', items: overdue }, { title: 'Por vencer este mes', items: thisMonth }, { title: 'Vencimientos del próximo mes', items: nextMonth }]
  const line = (item) => `${item.personId ? `${item.personName} · ${item.personIdentification}` : `${item.vehiclePlate} · ${item.vehicleName}`} · ${item.typeName} · ${item.formattedExpirationDate} · ${item.daysRemaining < 0 ? 'Vencido' : `${item.daysRemaining} días`}`
  const text = [store.settings.companyName, config.notes, ...sections.flatMap((section) => [section.title, ...(section.items.length ? section.items.map(line) : ['Sin documentos en este período.'])])].join('\n\n')
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;padding:24px;font-family:Arial,sans-serif;color:#18253b;background:#f4f6fa"><main style="max-width:720px;margin:auto;background:white;padding:24px;border-radius:12px"><h1 style="font-size:22px">${escapeHtml(store.settings.companyName)}</h1><p style="white-space:pre-wrap">${escapeHtml(config.notes)}</p><p>Informe al ${escapeHtml(clock.date)} (${escapeHtml(timezone)})</p>${sections.map((section) => `<h2 style="font-size:17px;margin-top:28px">${section.title} (${section.items.length})</h2>${section.items.length ? section.items.map((item) => `<p style="padding:12px;border:1px solid #dde4ed;border-radius:6px;overflow-wrap:anywhere">${escapeHtml(line(item))}</p>`).join('') : '<p>Sin documentos en este período.</p>'}`).join('')}</main></body></html>`
  return { subject: config.subject, html, text, counts: { overdue: overdue.length, thisMonth: thisMonth.length, nextMonth: nextMonth.length } }
}

export function isEmailAddress(value) {
  return typeof value === 'string' && emailPattern.test(value.trim())
}

const tlsErrorCodes = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']

// Traduce el código de Nodemailer a una causa accionable sin exponer la respuesta del servidor ni credenciales.
export function smtpErrorMessage(error) {
  const code = error?.code || ''
  if (code === 'EAUTH' || code === 'ENOAUTH') return 'El servidor SMTP rechazó el usuario o la contraseña. Revisá SMTP_USER y SMTP_PASS.'
  if (tlsErrorCodes.includes(code) || (code === 'ESOCKET' && /certificate|ssl|tls/i.test(String(error?.reason || error?.message || '')))) return 'Falló la negociación TLS. Revisá SMTP_SECURE (true en el puerto 465, false en el 587) y SMTP_TLS_SERVERNAME.'
  if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'ESOCKET', 'EHOSTUNREACH'].includes(code)) return 'No se pudo conectar con el servidor SMTP. Revisá SMTP_HOST, SMTP_PORT y que el firewall permita la salida.'
  if (code === 'EENVELOPE') return 'El servidor SMTP rechazó el remitente o los destinatarios. Verificá que SMTP_FROM esté autorizado para la cuenta.'
  if (code === 'EMESSAGE') return 'El servidor SMTP rechazó el contenido del mensaje.'
  return 'No se pudo confirmar el envío. Verificá la conexión, credenciales, TLS y permisos de relay del servidor SMTP.'
}

export function logSmtpError(context, error) {
  console.error(`SMTP (${context}): ${error?.code || 'sin código'}${error?.responseCode ? ` · respuesta ${error.responseCode}` : ''}${error?.command ? ` · comando ${error.command}` : ''}`)
}

export function createMailer(env = process.env, transportFactory = nodemailer.createTransport) {
  function options() {
    const port = Number(env.SMTP_PORT || 587)
    if (!env.SMTP_HOST || !emailPattern.test(env.SMTP_FROM || '')) throw Object.assign(new Error('Configurá SMTP_HOST y SMTP_FROM en el servidor'), { statusCode: 503 })
    if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('SMTP_PORT no es válido')
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) invalid('Configurá SMTP_USER y SMTP_PASS juntos, o dejá ambos vacíos para un relay propio')
    // Sin SMTP_SECURE explícito, el puerto 465 usa TLS directo; los demás, STARTTLS.
    const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465
    return { host: env.SMTP_HOST, port, secure, requireTLS: !secure && env.SMTP_REQUIRE_TLS !== 'false', ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}), tls: { minVersion: 'TLSv1.2', ...(env.SMTP_TLS_SERVERNAME ? { servername: env.SMTP_TLS_SERVERNAME } : {}) }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000, disableFileAccess: true, disableUrlAccess: true }
  }
  return {
    status() {
      try { const { port, secure } = options(); return { configured: true, from: env.SMTP_FROM, host: env.SMTP_HOST, port, secure } } catch (error) { return { configured: false, from: '', message: error.message } }
    },
    async verify() { return transportFactory(options()).verify() },
    async send(config, report, recipients = config.recipients) {
      const transport = transportFactory(options())
      const info = await transport.sendMail({ from: { name: env.SMTP_FROM_NAME || 'MyCarManagement', address: env.SMTP_FROM }, to: recipients, subject: report.subject, text: report.text, html: report.html })
      return { messageId: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] }
    },
  }
}

// Prueba puntual: no modifica la programación ni el estado del último envío.
export async function sendTestEmail({ store, config, mailer, recipient, now = new Date() }) {
  const to = String(recipient || '').trim().toLowerCase()
  if (!isEmailAddress(to)) invalid('Ingresá un email válido para la prueba')
  const report = buildEmailReport(store, config, now)
  try {
    const result = await mailer.send(config, { ...report, subject: `[Prueba] ${report.subject}` }, [to])
    if (!result.accepted.length) throw Object.assign(new Error('rejected'), { code: 'EENVELOPE' })
    return { recipient: to, messageId: result.messageId }
  } catch (error) {
    logSmtpError('prueba', error)
    throw Object.assign(new Error(smtpErrorMessage(error)), { statusCode: 502 })
  }
}

export async function deliverEmail({ store, config, mailer, writeStore, now = new Date(), key = null }) {
  if (!config.recipients.length) invalid('Añadí al menos un destinatario')
  // Persistir la reserva antes de contactar SMTP evita duplicar la misma ocurrencia tras un reinicio.
  // Un intento fallido requiere reenvío manual; SMTP no garantiza entrega exactamente una vez.
  const state = { ...config, lastAttemptAt: now.toISOString(), lastStatus: 'sending', lastError: null, ...(key ? { lastScheduledKey: key } : {}) }
  store.settings.emailAlerts = state
  await writeStore(store)
  try {
    const result = await mailer.send(config, buildEmailReport(store, config, now))
    if (!result.accepted.length) throw Object.assign(new Error('El servidor SMTP no aceptó ningún destinatario'), { code: 'EENVELOPE' })
    Object.assign(state, { lastSentAt: now.toISOString(), lastStatus: result.rejected.length ? 'partial' : 'sent', lastResult: result })
  } catch (error) {
    logSmtpError(key ? 'programado' : 'manual', error)
    Object.assign(state, { lastStatus: 'failed', lastError: smtpErrorMessage(error) })
  }
  await writeStore(store)
  return state
}

export async function runScheduledEmail({ readStore, writeStore, mailer, now = new Date() }) {
  if (!mailer.status().configured) return null
  const store = await readStore()
  const config = emailConfig(store.settings, now)
  const key = scheduledKey(config, store.settings.timezone || 'America/Argentina/Buenos_Aires', now)
  if (!key || key === config.lastScheduledKey) return null
  return deliverEmail({ store, config, mailer, writeStore, now, key })
}
