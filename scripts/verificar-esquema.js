/**
 * Verifica que database/schema.sql, database/backup.sql y schema.sql + seed.sql
 * crean EXACTAMENTE las tablas que definen las entidades de TypeORM:
 *   1. restaura cada archivo con psql en una base nueva;
 *   2. le pregunta a TypeORM qué cambiaría para que la base coincida con las
 *      entidades (el mismo cálculo de synchronize: true): debe ser nada;
 *   3. revisa que no sobren ni falten tablas.
 * Además corre un caso de control (schema.sql con una columna alterada a
 * propósito) que DEBE fallar: así se sabe que la verificación detecta diferencias.
 *
 * Uso (después de `npm run build`; en CI lo corre el workflow):
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/verificar-esquema.js
 */
require('reflect-metadata');
const { execFileSync } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { DataSource } = require('typeorm');
const { ENTITIES } = require('../dist/entities');

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = path.join(__dirname, '..', 'database');
const CASES = [{ files: ['schema.sql'] }, { files: ['backup.sql'] }, { files: ['schema.sql', 'seed.sql'] }];
// Control: si el verificador no detecta esto, no sirve.
const CONTROL = {
  files: ['schema.sql'],
  sql: 'ALTER TABLE public.rewards_closures ALTER COLUMN forfeited_points TYPE bigint; DROP INDEX public.uq_redemptions_idempotency;',
};

async function admin(sql) {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Devuelve la lista de problemas (vacía si el archivo coincide con las entidades). */
async function check({ files, sql }, n) {
  const name = `verificar_esquema_${process.pid}_${n}`;
  await admin(`DROP DATABASE IF EXISTS ${name}`);
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  try {
    const psql = (...args) =>
      execFileSync('psql', [url.toString(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    for (const file of files) psql('-f', path.join(DB_DIR, file));
    if (sql) psql('-c', sql);
    const dataSource = new DataSource({
      type: 'postgres',
      url: url.toString(),
      entities: ENTITIES,
      synchronize: false,
    });
    await dataSource.initialize();
    try {
      const problems = [];
      const pending = await dataSource.driver.createSchemaBuilder().log();
      for (const query of pending.upQueries) problems.push(`TypeORM cambiaría: ${query.query}`);

      const rows = await dataSource.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      );
      const actual = new Set(rows.map((r) => r.table_name));
      const expected = new Set(dataSource.entityMetadatas.map((m) => m.tableName));
      for (const t of actual) if (!expected.has(t)) problems.push(`Tabla que no tiene entidad: ${t}`);
      for (const t of expected) if (!actual.has(t)) problems.push(`Falta la tabla: ${t}`);
      return problems;
    } finally {
      await dataSource.destroy();
    }
  } finally {
    await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

async function main() {
  if (!ADMIN_URL) throw new Error('Define TEST_DATABASE_URL (conexión con permiso para crear bases).');
  let failed = false;
  for (const [i, testCase] of CASES.entries()) {
    const label = testCase.files.map((f) => `database/${f}`).join(' + ');
    const problems = await check(testCase, i);
    if (problems.length) {
      failed = true;
      console.error(`✗ ${label}:\n  - ${problems.join('\n  - ')}`);
    } else {
      console.log(`✓ ${label}: coincide con las entidades (${ENTITIES.length} tablas, TypeORM no cambiaría nada).`);
    }
  }
  const control = await check(CONTROL, CASES.length);
  if (control.length) {
    console.log(`✓ Control (esquema alterado a propósito): detectado (${control.length} diferencia(s)).`);
  } else {
    failed = true;
    console.error(
      '✗ Control: el esquema alterado a propósito pasó la verificación; el verificador no detecta diferencias.',
    );
  }
  if (failed) {
    console.error('\nActualiza database/ para que coincida con las entidades (src/entities.ts).');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
