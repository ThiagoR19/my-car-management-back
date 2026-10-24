import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { buildEmailReport, createMailer, emailConfig, frequencies, runScheduledEmail, scheduledKey, smtpErrorMessage, validateEmailConfig } from './email.js'
import { createApiServer } from './server.js'
import { passwordRecord } from './store.js'

const timezone = 'America/Argentina/Buenos_Aires'
const config = (changes = {}) => ({ ...emailConfig({ timezone }), active: true, triggerDate: '2026-10-19', triggerTime: '08:00', recipients: ['flota@example.com'], ...changes })
const baseStore = () => ({ settings: { companyName: 'Test <Flota>', timezone }, vehicles: [{ id: 'v1', plate: 'ABC123', brand: 'Test', model: 'Camión', status: 'Activo' }, { id: 'v2', status: 'Baja' }], documentTypes: [{ id: 't1', name: 'RTO', alertDays: 30 }], documents: [
  { id: 'd1', vehicleId: 'v1', typeId: 't1', expirationDate: '2026-10-18' },
  { id: 'd2', vehicleId: 'v1', typeId: 't1', expirationDate: '2026-10-20' },
  { id: 'd3', vehicleId: 'v1', typeId: 't1', expirationDate: '2026-11-01' },
  { id: 'd4', vehicleId: 'v1', typeId: 't1', expirationDate: '2026-11-02', active: false },
  { id: 'd5', vehicleId: 'v2', typeId: 't1', expirationDate: '2026-11-02' },
] })

test('programación respeta hora argentina, pausa, inicio y frecuencia', () => {
  assert.equal(scheduledKey(config(), timezone, new Date('2026-10-19T10:59:00Z')), null)
  assert.equal(scheduledKey(config(), timezone, new Date('2026-10-19T11:00:00Z')), '2026-10-19T08:00')
  assert.equal(scheduledKey(config({ active: false }), timezone, new Date('2026-10-19T15:00:00Z')), null)
  assert.equal(scheduledKey(config({ triggerFrequency: frequencies[2] }), timezone, new Date('2026-10-25T15:00:00Z')), '2026-10-19T08:00')
  assert.equal(scheduledKey(config({ triggerFrequency: frequencies[1] }), timezone, new Date('2026-10-30T15:00:00Z')), null)
  assert.equal(scheduledKey(config({ triggerFrequency: frequencies[1] }), timezone, new Date('2026-11-01T11:00:00Z')), '2026-11-01T08:00')
  assert.equal(scheduledKey(config({ triggerFrequency: frequencies[3] }), timezone, new Date('2026-11-10T11:00:00Z')), '2026-10-19T08:00')
})

test('mensual ajusta fin de mes y atraviesa diciembre y años bisiestos', () => {
  const monthly = config({ triggerDate: '2026-01-31' })
  assert.equal(scheduledKey(monthly, timezone, new Date('2026-02-28T11:00:00Z')), '2026-02-28T08:00')
  assert.equal(scheduledKey(monthly, timezone, new Date('2026-03-01T11:00:00Z')), '2026-02-28T08:00')
  assert.equal(scheduledKey(monthly, timezone, new Date('2028-02-29T11:00:00Z')), '2028-02-29T08:00')
  assert.equal(scheduledKey(monthly, timezone, new Date('2027-01-01T11:00:00Z')), '2026-12-31T08:00')
})

test('valida destinatarios, fechas y asunto; no acepta estado de envío del cliente', () => {
  const previous = config({ lastScheduledKey: 'reserva-del-servidor' })
  assert.equal(validateEmailConfig(config({ lastScheduledKey: 'falso' }), previous).lastScheduledKey, 'reserva-del-servidor')
  for (const changes of [{ triggerDate: '2026-02-30' }, { recipients: ['alguien@example.com\r\nBcc: otro@example.com'] }, { triggerTime: '25:00' }, { subject: 'Asunto\r\nBcc: otro@example.com' }, { recipients: [] }]) assert.throws(() => validateEmailConfig(config(changes), previous))
  assert.deepEqual(validateEmailConfig(config({ recipients: ['Flota@example.com', 'flota@example.com'] }), previous).recipients, ['flota@example.com'])
})

test('informe usa zona configurada, no duplica vencidos y escapa HTML', () => {
  const report = buildEmailReport(baseStore(), config({ notes: '<script>alert(1)</script>' }), new Date('2026-10-20T01:00:00Z'))
  assert.deepEqual(report.counts, { overdue: 1, thisMonth: 1, nextMonth: 1 })
  assert.equal((report.html.match(/ABC123/g) || []).length, 3)
  assert.ok(report.html.includes('&lt;script&gt;'))
  assert.ok(report.html.includes('2026-10-19'))
  assert.ok(!report.html.includes('<script>'))
})

test('reserva persistida impide duplicados tras reinicio y distingue rechazo parcial y falla', async () => {
  let store = baseStore()
  store.settings.emailAlerts = config()
  const now = new Date('2026-10-19T11:00:00Z')
  let sends = 0
  const context = { readStore: async () => structuredClone(store), writeStore: async (next) => { store = structuredClone(next) }, now, mailer: { status: () => ({ configured: true }), send: async () => {
    sends++
    assert.equal(store.settings.emailAlerts.lastStatus, 'sending')
    assert.equal(store.settings.emailAlerts.lastScheduledKey, '2026-10-19T08:00')
    return { accepted: ['flota@example.com'], rejected: ['otro@example.com'] }
  } } }
  assert.equal((await runScheduledEmail(context)).lastStatus, 'partial')
  assert.equal(await runScheduledEmail({ ...context }), null)
  assert.equal(sends, 1)
  store.settings.emailAlerts.lastScheduledKey = null
  context.mailer.send = async () => { throw new Error('secret-password') }
  assert.equal((await runScheduledEmail(context)).lastStatus, 'failed')
  assert.ok(!store.settings.emailAlerts.lastError.includes('secret-password'))
  assert.equal(await runScheduledEmail(context), null)
})

test('SMTP real entrega el MIME a un relay local sin enviar correos externos', async (t) => {
  let message = ''
  const smtp = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.write('220 localhost ESMTP\r\n')
    let buffer = ''
    let data = false
    socket.on('data', (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data && line !== '.') { message += `${line}\r\n`; continue }
        if (data) { data = false; socket.write('250 queued\r\n') }
        else if (/^EHLO/.test(line)) socket.write('250-localhost\r\n250 8BITMIME\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 send message\r\n') }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 OK\r\n')
      }
    })
  })
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => smtp.close(resolve)))
  const mailer = createMailer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_FROM: 'alertas@example.com', SMTP_REQUIRE_TLS: 'false' })
  await mailer.verify()
  const result = await mailer.send(config(), buildEmailReport(baseStore(), config()))
  assert.deepEqual(result.accepted, ['flota@example.com'])
  assert.ok(message.includes('multipart/alternative'))
  assert.ok(message.includes('text/html'))
  assert.ok(message.includes('text/plain'))
})

test('API protege emails, persiste configuración y usa datos reales al enviar', async (t) => {
  let store = { ...baseStore(), accessRequests: [], audit: [], notifications: [], employees: [
    { id: 'admin', username: 'admin', email: 'admin@example.com', name: 'Admin', active: true, role: 'Administrador', ...passwordRecord('password123') },
    { id: 'worker', username: 'worker', email: 'worker@example.com', name: 'Worker', active: true, role: 'Empleado', ...passwordRecord('password123') },
  ] }
  const sent = []
  const server = createApiServer({ readStore: async () => structuredClone(store), writeStore: async (next) => { store = structuredClone(next) }, mailer: { status: () => ({ configured: true, from: 'alerts@example.com' }), verify: async () => true, send: async (next, report, to = next.recipients) => { sent.push({ next, report, to }); return { accepted: to, rejected: [] } } } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const request = async (path, method = 'GET', body, token) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: result.status, body: await result.json() }
  }
  const admin = (await request('/auth/login', 'POST', { identifier: 'admin', password: 'password123' })).body.token
  const worker = (await request('/auth/login', 'POST', { identifier: 'worker', password: 'password123' })).body.token
  assert.equal((await request('/email-alerts')).status, 401)
  for (const [method, path] of [['GET', ''], ['PUT', ''], ['POST', '/send'], ['POST', '/preview'], ['POST', '/verify'], ['POST', '/test']]) assert.equal((await request(`/email-alerts${path}`, method, method === 'GET' ? null : config(), worker)).status, 403)
  assert.equal((await request('/email-alerts', 'PUT', config(), admin)).status, 200)
  assert.equal((await request('/email-alerts', 'GET', null, admin)).body.config.active, true)
  const result = await request('/email-alerts/send', 'POST', config({ notes: 'Texto personalizado', sections: { fake: true } }), admin)
  assert.equal(result.status, 200)
  assert.equal(result.body.config.lastStatus, 'sent')
  assert.equal(sent.length, 1)
  assert.ok(sent[0].report.text.includes('Texto personalizado'))
  assert.ok(sent[0].report.text.includes('ABC123'))
  assert.equal(sent[0].next.sections, undefined)
  assert.equal((await request('/email-alerts', 'GET', null, admin)).body.testRecipient, 'admin@example.com')
  assert.equal((await request('/email-alerts/test', 'POST', { ...config(), testRecipient: 'no-es-email' }, admin)).status, 400)
  const before = structuredClone(store.settings.emailAlerts)
  const trial = await request('/email-alerts/test', 'POST', { ...config({ subject: 'Informe editado' }), testRecipient: 'Prueba@Example.com' }, admin)
  assert.equal(trial.status, 200)
  assert.deepEqual(sent[1].to, ['prueba@example.com'])
  assert.equal(sent[1].report.subject, '[Prueba] Informe editado')
  assert.deepEqual(store.settings.emailAlerts, before)
  await request('/settings', 'PUT', { companyName: 'Cambio', emailAlerts: { active: false } }, admin)
  assert.equal(store.settings.emailAlerts.active, true)
  assert.equal((await request('/settings', 'PUT', { timezone: 'zona-inexistente' }, admin)).status, 400)
  assert.equal(store.settings.timezone, timezone)
})

test('SMTP infiere TLS directo en 465 y traduce errores sin exponer detalles', () => {
  const base = { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'alertas@example.com', SMTP_USER: 'alertas@example.com', SMTP_PASS: 'x' }
  assert.equal(createMailer({ ...base, SMTP_PORT: '465' }).status().secure, true)
  assert.equal(createMailer({ ...base, SMTP_PORT: '587' }).status().secure, false)
  assert.equal(createMailer({ ...base, SMTP_PORT: '465', SMTP_SECURE: 'false' }).status().secure, false)
  let options
  createMailer({ ...base, SMTP_PORT: '465' }, (value) => { options = value; return { verify: async () => true } }).verify()
  assert.equal(options.requireTLS, false)
  assert.match(smtpErrorMessage({ code: 'EAUTH', message: '535 secret-password' }), /SMTP_USER y SMTP_PASS/)
  assert.match(smtpErrorMessage({ code: 'ETIMEDOUT' }), /SMTP_HOST, SMTP_PORT/)
  assert.match(smtpErrorMessage({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), /TLS/)
  assert.match(smtpErrorMessage({ code: 'EENVELOPE' }), /SMTP_FROM/)
  assert.ok(!smtpErrorMessage({ code: 'EAUTH', message: 'secret-password' }).includes('secret-password'))
})
