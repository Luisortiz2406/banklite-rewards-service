# Rewards Service (`rewards-service`)

[![CI](https://github.com/Luisortiz2406/banklite-rewards-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-rewards-service/actions/workflows/ci.yml)

Puntos BankLite: acumulación por movimientos, niveles, retos y canjes.

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Escucha `transaction.completed` y suma puntos según el monto y el nivel del cliente.
Los puntos se canjean por dinero en la cuenta, recargas o cupones; los canjes que
mueven dinero se pagan desde la cuenta de sistema **Recompensas** del ledger con el
patrón *reservar → registrar en el ledger → aplicar* (si el ledger rechaza, se
devuelven los puntos; si la falla es incierta, queda pendiente y se reintenta con la
misma clave).

**Reglas de negocio principales**

- 1 punto por cada $1.000 (base), multiplicado por el nivel: Bronce ×1, Plata ×1,25, Oro ×1,5 (valores en `GET /rewards/catalog`).
- No se suman dos veces los puntos del mismo evento (`source_key` única).
- No se canjea más de lo disponible; los puntos reservados no se pueden usar en otro canje.
- Retos (p. ej. de ahorro) consultados a savings-service.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — |
| Consume eventos | `transaction.completed` (ledger) |
| Llama a | ledger-service: `/ledger/internal/rewards`<br>payment-service: recargas con puntos<br>account-service: cuenta del cliente<br>kyc-service: nombre<br>savings-service: retos de ahorro |
| Lo llaman | api-gateway (rutas `/rewards/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/rewards`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, outbox, reintentos y DLQ
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`rewards_db`)

| Tabla | Contenido |
|---|---|
| `points_entries` | Movimientos de puntos (ganados, canjeados, insignias), con `source_key` única. |
| `redemptions` | Canjes, su estado y la transacción del ledger. |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb rewards_db
psql "postgres://usuario:clave@localhost:5432/rewards_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16, RabbitMQ 3.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-rewards-service .
docker run --env-file .env -p 3012:3012 banklite-rewards-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3012/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/rewards/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |
| GET | `/rewards/catalog` | Valor del punto, puntos por monto y niveles. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/rewards` | Puntos, nivel, retos e historial del cliente. |
| POST | `/rewards/redeem` | Canjea puntos (dinero, recarga o cupón). |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3012` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://rewards_svc:<DB_PASSWORD_REWARDS>@localhost:5432/rewards_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ. Sin ella los eventos quedan en el outbox (o no se consumen). |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos (`banklite.events`). |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service. |
| `PAYMENT_SERVICE_URL` | Sí | `http://localhost:3011` | URL interna de payment-service. |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `KYC_SERVICE_URL` | Sí | `http://localhost:3003` | URL interna de kyc-service. |
| `SAVINGS_SERVICE_URL` | Sí | `http://localhost:3013` | URL interna de savings-service. |
| `RABBITMQ_QUEUE` | No | `rewards-service.transaction-completed` | Cola propia del servicio (con `<cola>.retry` y `<cola>.dlq`). |
| `EVENT_MAX_RETRIES` | No | `5` | Reintentos de un evento antes de mandarlo a la DLQ. |
| `EVENT_RETRY_DELAY_MS` | No | `10000` | Espera entre reintentos de un evento. |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Pruebas

Pruebas de reglas de negocio (Jest): el mismo evento no suma puntos dos veces (también en paralelo), qué movimientos suman, multiplicador por nivel, reversos, y canjes con reserva, devolución y reintento.

Corren contra un PostgreSQL real, porque esas reglas dependen de transacciones,
bloqueos e índices únicos. Cada corrida crea una base temporal y la borra al terminar:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

Sin `TEST_DATABASE_URL` se omiten en local; en la CI son obligatorias (el workflow
levanta un Postgres de servicio).

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`): `railway.json` en la
raíz define el build por `Dockerfile` y el health check en `/health`; cada push a
`main` redespliega el servicio. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `rewards-service`: `status` y `database` deben estar en `ok`)
- Endpoint público de prueba: https://api-gateway-production-dd7f.up.railway.app/rewards/catalog
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/rewards/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** canjes (`/ledger/internal/rewards`)<br>**Recibe:** `transaction.completed` |
| [banklite-payment-service](https://github.com/Luisortiz2406/banklite-payment-service) | **Llama a:** recargas pagadas con puntos |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** cuenta del cliente |
| [banklite-kyc-service](https://github.com/Luisortiz2406/banklite-kyc-service) | **Llama a:** nombre del cliente |
| [banklite-savings-service](https://github.com/Luisortiz2406/banklite-savings-service) | **Llama a:** progreso de los retos de ahorro |
