import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Cliente que canceló su cuenta Banklite (evento account.closed). Una fila por
 * cliente: la clave primaria hace que procesar el evento dos veces no descuente
 * dos veces. Desde aquí, rewards no le suma puntos (los movimientos tardíos se
 * ignoran y quedan en el log) ni le devuelve canjes fallidos.
 */
@Entity('rewards_closures')
export class RewardsClosure {
  @PrimaryColumn({ name: 'id_user', type: 'uuid' })
  idUser: string;

  // cerradaEn del evento (cuándo canceló el cliente).
  @Column({ name: 'closed_at', type: 'timestamptz' })
  closedAt: Date;

  // Puntos que tenía y perdió al cancelar (0 si no tenía).
  @Column({ name: 'forfeited_points', type: 'int' })
  forfeitedPoints: number;

  @CreateDateColumn({ name: 'processed_at', type: 'timestamptz' })
  processedAt: Date;
}
