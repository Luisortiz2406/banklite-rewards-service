import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Libro de puntos: el saldo es la suma de los asientos de un cliente.
 * - earn: puntos por un movimiento (sourceKey earn:<transactionId>)
 * - badge: reto cumplido (badge:<id>)
 * - redeem: canje, en negativo (redeem:<redemptionId>)
 * - refund: devolución de un canje que falló (refund:<redemptionId>)
 * - reversal: el movimiento que dio puntos se reversó (reversal:<transactionId>)
 * - forfeit: el cliente canceló su cuenta y perdió el saldo, en negativo (closure:<idUser>)
 * (cliente, sourceKey) es único: un evento reentregado o un doble clic nunca suma
 * dos veces, y cada cliente cumple sus propios retos.
 */
export type PointsKind = 'earn' | 'badge' | 'redeem' | 'refund' | 'reversal' | 'forfeit';

@Entity('points_entries')
@Index('idx_points_entries_user_created', ['idUser', 'createdAt'])
@Index('uq_points_entries_user_source', ['idUser', 'sourceKey'], { unique: true })
export class PointsEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ type: 'int' })
  points: number;

  @Column({ type: 'varchar', length: 10 })
  kind: PointsKind;

  @Column({ type: 'varchar', length: 80 })
  title: string;

  @Column({ type: 'varchar', length: 160, default: '' })
  detail: string;

  @Column({ name: 'source_key', type: 'varchar', length: 80 })
  sourceKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
