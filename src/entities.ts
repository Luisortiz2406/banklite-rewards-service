import { PointsEntry } from './rewards/entities/points-entry.entity';
import { Redemption } from './rewards/entities/redemption.entity';
import { RewardsClosure } from './rewards/entities/rewards-closure.entity';

/**
 * Todas las tablas de rewards_db. La usan TypeORM al arrancar y
 * scripts/verificar-esquema.js (CI), que comprueba que database/schema.sql y
 * database/backup.sql crean exactamente estas tablas.
 */
export const ENTITIES = [PointsEntry, Redemption, RewardsClosure];
