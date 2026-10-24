# MyCarManagement API

Esta carpeta contiene todo el backend: servidor HTTP, migraciones Drizzle, esquema MySQL, archivos cargados y sus dependencias.

## Local

```bash
npm install
copy .env.example .env
npm run start
```

Comandos disponibles:

- `npm run start`: inicia la API en el puerto definido por `PORT` o `3000`.
- `npm run dev`: inicia la API con reinicio automático.
- `npm run setup:admin`: crea el primer administrador usando las variables `BOOTSTRAP_ADMIN_*`.
- `npm test`: ejecuta las pruebas del backend.

Importá `mysql-schema.sql` en MySQL/phpMyAdmin antes de iniciar la API y configurá `DATABASE_URL`.

## Render

Este repositorio ya contiene la API en su raíz. Si configurás **Root Directory** en Render, dejalo vacío; después usá estos valores:

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

Variables obligatorias:

- `DATABASE_URL`: URL de conexión MySQL. La base tiene que aceptar conexiones desde internet: un hosting compartido que solo expone `localhost` no sirve. Para bases en la nube como Aiven, agregá `?ssl-mode=REQUIRED` al final de la URL.
- `DATABASE_CA_CERT`: solo si el proveedor usa una CA propia (Aiven): pegá el contenido completo del `ca.pem`.
- Variables `SMTP_*` de `.env.example` si vas a usar alertas por correo.

Después del primer despliegue, importá el esquema en la base y ejecutá una vez `npm run setup:admin` con las variables `BOOTSTRAP_ADMIN_*`. Eliminá esas variables después de crear el administrador.
