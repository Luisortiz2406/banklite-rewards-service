import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { RewardKind } from '../catalog';

/**
 * Canje de puntos. pending: puntos reservados, entregando el premio;
 * completed: entregado; failed: no se pudo entregar y los puntos se devolvieron.
 */
export type RedemptionStatus = 'pending' | 'completed' | 'failed';

@Entity('redemptions')
@Index('idx_redemptions_user_created', ['idUser', 'createdAt'])
export class Redemption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ name: 'reward_id', type: 'varchar', length: 20 })
  rewardId: string;

  @Column({ type: 'varchar', length: 10 })
  kind: RewardKind;

  @Column({ type: 'int' })
  points: number;

  // Doble clic o reintento con la misma clave: el mismo canje, nunca dos.
  @Index('uq_redemptions_idempotency', { unique: true })
  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 10 })
  status: RedemptionStatus;

  // Recarga: operador elegido y celular verificado del cliente.
  @Column({ name: 'operator_code', type: 'varchar', length: 40, nullable: true })
  operatorCode: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  phone: string | null;

  @Column({ name: 'coupon_code', type: 'varchar', length: 20, nullable: true })
  couponCode: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'ledger_transaction_id', type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @Column({ name: 'failure_reason', type: 'varchar', length: 200, nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
