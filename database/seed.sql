-- Datos de ejemplo de rewards_db (rewards-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;
-- 1 punto por cada $1.000 (GET /rewards/catalog): el pago de $85.000 da 85 puntos.
INSERT INTO public.points_entries (id, id_user, points, kind, title, detail, source_key, created_at) VALUES
  ('40000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 85, 'earn', 'Pago de factura', 'Acueducto de Bogotá · $85.000', 'earn:7b000000-0000-4000-8000-000000000004', '2026-10-04 10:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
