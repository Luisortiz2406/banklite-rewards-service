import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env.validation';
import { HealthController } from './health.controller';
import { PointsEntry } from './rewards/entities/points-entry.entity';
import { Redemption } from './rewards/entities/redemption.entity';
import { RewardsModule } from './rewards/rewards.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
          { key: 'JWT_SECRET', type: 'secret' },
          { key: 'INTERNAL_API_KEY', type: 'secret' },
          { key: 'DATABASE_URL', type: 'url' },
          { key: 'RABBITMQ_URL', type: 'url', optional: true },
        ],
        ['JWT_SECRET', 'INTERNAL_API_KEY'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [PointsEntry, Redemption],
        synchronize: true,
        logging: false,
      }),
    }),
    RewardsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
