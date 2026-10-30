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
- `npm run db:migrate -- --check`: consulta cuántas migraciones faltan, sin modificar la base.
- `npm run db:migrate`: aplica las migraciones pendientes de forma incremental, conservando los datos existentes.
- `npm test`: ejecuta las pruebas del backend.

Importá `mysql-schema.sql` en MySQL/phpMyAdmin antes de iniciar la API y configurá `DATABASE_URL`.

Si la base ya existe, ejecutá `npm run db:migrate` desde esta carpeta antes de desplegar la API actualizada. La migración `0001_people.sql` agrega `people`, `person_documents`, `person_document_files` y la relación opcional `vehicles.person_id`, sin reconstruir las tablas actuales. Para una instalación nueva podés usar el esquema completo o ejecutar todas las migraciones con el mismo comando.

La migración `0002_audit_indexes.sql` agrega dos índices a `audits` (fecha e identificador; entidad y registro) sin modificar datos. Ejecutala antes de desplegar la versión con historial paginado.

## Historial paginado

El historial crece sin límite, así que no se carga con el resto de los datos: cada petición lee solo lo que necesita y los guardados insertan únicamente los eventos nuevos.

- `GET /api/audit?page=1&pageSize=30&q=texto` (solo administradores) devuelve `{ items, total, page, pageSize, totalPages }`. `pageSize` admite hasta 100; una página fuera de rango se ajusta a la última disponible.
- `q` busca en autor, email, acción, entidad, identificador y datos del evento, y también reconoce etiquetas en castellano como «renovó», «eliminó», «vehículo» o «repuesto».
- `GET /api/vehicles/:id/history?limit=20&cursor=…` devuelve la ficha de a una página (`{ items, total, hasMore, nextCursor }`, hasta 100 por página), intercalando eventos, reparaciones y altas. Para la página siguiente se envía el `nextCursor` recibido; el costo es el mismo en cualquier página y no se repiten eventos aunque compartan la misma hora.

Para comprobar las consultas contra un MySQL o MariaDB real ya migrado, sin modificar datos: `TEST_DATABASE_URL=mysql://usuario:contrasena@host:3306/base npm test`.

Personas comparte el catálogo `document_types` con Vehículos. Sus documentos y adjuntos tienen tablas propias y conservan versiones anteriores al renovar. Cada vehículo admite una persona asignada y una persona puede estar asociada con varios vehículos. El campo de conductor anterior se conserva para los registros existentes.

## Render

Este repositorio ya contiene la API en su raíz. Si configurás **Root Directory** en Render, dejalo vacío; después usá estos valores:

- Build Command: `npm ci`
- Pre-Deploy Command: `npm run db:migrate`
- Start Command: `npm start`
- Health Check Path: `/api/health`

El Blueprint configura un disco persistente en `/var/data` y guarda los adjuntos en `/var/data/uploads`. El servicio queda en una sola instancia porque los discos persistentes no se comparten entre instancias. Para escalar, migrá los adjuntos a un bucket privado S3-compatible.

Variables obligatorias:

- `DATABASE_URL`: URL de conexión MySQL. La base tiene que aceptar conexiones desde internet: un hosting compartido que solo expone `localhost` no sirve. Para bases en la nube como Aiven, agregá `?ssl-mode=REQUIRED` al final de la URL.
- `DATABASE_CA_CERT`: solo si el proveedor usa una CA propia (Aiven): pegá el contenido completo del `ca.pem`.
- `DATABASE_SSL=required` en producción fuerza TLS aunque la URL no incluya `ssl-mode`.
- `CORS_ORIGINS`: obligatorio en producción; configurá el origen exacto del frontend, sin `*`.
- Variables `SMTP_*` de `.env.example` si vas a usar alertas por correo.

Después del primer despliegue, importá el esquema en la base y ejecutá una vez `npm run setup:admin` con las variables `BOOTSTRAP_ADMIN_*`. Eliminá esas variables después de crear el administrador.

## CORS y errores de conexión

CORS se configura con la variable `CORS_ORIGINS`, que acepta una lista separada por comas. En producción la API rechaza iniciar si falta la variable o contiene `*`; usá el origen exacto del frontend, por ejemplo `CORS_ORIGINS=https://tu-frontend.example.com`. El frontend usa tokens Bearer, sin cookies entre dominios.

Login, registro y adjuntos tienen límites de frecuencia por IP. El límite evita fuerza bruta y abuso básico; para despliegues con varias instancias debe complementarse con un rate limiter en el proxy o WAF.

Después de subir estos cambios al repositorio del backend, desplegá esa versión en Render. Cambiar el frontend o reiniciar Vite no actualiza la API remota.

Si Render devuelve `500` con `Invalid URL`, revisá `DATABASE_URL` en el entorno del servicio: debe tener el formato `mysql://usuario:contrasena@host:3306/base`, sin comillas exteriores. Codificá por separado el usuario y la contraseña con `encodeURIComponent` si contienen caracteres reservados; por ejemplo, `/` se representa como `%2F`, `@` como `%40` y `#` como `%23`. No codifiques la URL completa. Este error de configuración debe corregirse para que funcionen el login y las demás operaciones con la base.
