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

- `DATABASE_URL`: URL de conexión MySQL.
- Variables `SMTP_*` de `.env.example` si vas a usar alertas por correo.

Después del primer despliegue, importá el esquema en la base y ejecutá una vez `npm run setup:admin` con las variables `BOOTSTRAP_ADMIN_*`. Eliminá esas variables después de crear el administrador.

## CORS y errores de conexión

CORS está habilitado globalmente para cualquier origen y ruta, incluidos archivos y respuestas de error. Se configura con la dependencia `cors` y la variable `CORS_ORIGINS`, que acepta una lista separada por comas; en producción configurá el origen exacto del frontend, por ejemplo `CORS_ORIGINS=https://tu-frontend.example.com`. Admite encabezados personalizados y los métodos `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` y `OPTIONS` en el preflight; cada endpoint conserva sus métodos y permisos de autenticación. Las solicitudes `OPTIONS` reciben `204` sin acceder a MySQL. El frontend usa tokens Bearer, sin cookies entre dominios.

Después de subir estos cambios al repositorio del backend, desplegá esa versión en Render. Cambiar el frontend o reiniciar Vite no actualiza la API remota.

Si Render devuelve `500` con `Invalid URL`, revisá `DATABASE_URL` en el entorno del servicio: debe tener el formato `mysql://usuario:contrasena@host:3306/base`, sin comillas exteriores. Codificá por separado el usuario y la contraseña con `encodeURIComponent` si contienen caracteres reservados; por ejemplo, `/` se representa como `%2F`, `@` como `%40` y `#` como `%23`. No codifiques la URL completa. Este error de configuración debe corregirse para que funcionen el login y las demás operaciones con la base.
