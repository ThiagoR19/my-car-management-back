import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeStore, passwordRecord, readStore, withStoreTransaction, writeStore } from './store.js'

export async function bootstrapAdmin(env = process.env) {
  const username = String(env.BOOTSTRAP_ADMIN_USERNAME || '').trim().toLowerCase()
  const email = String(env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = String(env.BOOTSTRAP_ADMIN_PASSWORD || '')
  if (!/^[a-z0-9._-]{3,30}$/.test(username) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) throw new Error('Configurá BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (mínimo 8 caracteres)')
  return withStoreTransaction(async () => {
    const store = await readStore()
    if (store.employees.length) throw new Error('El alta inicial solo se permite sin empleados existentes')
    store.employees.push({ id: `emp-${randomUUID()}`, username, email, name: env.BOOTSTRAP_ADMIN_NAME?.trim() || username, role: 'Administrador', active: true, createdAt: new Date().toISOString(), ...passwordRecord(password) })
    await writeStore(store)
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await bootstrapAdmin()
    console.log('Administrador inicial creado. Eliminá las variables BOOTSTRAP_ADMIN del entorno.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  } finally {
    await closeStore()
  }
}
