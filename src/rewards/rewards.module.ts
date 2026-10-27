import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AccountClosedConsumer } from '../events/account-closed.consumer';
import { EventConsumerService } from '../events/event-consumer.service';
import { PointsEntry } from './entities/points-entry.entity';
import { Redemption } from './entities/redemption.entity';
import { RewardsClosure } from './entities/rewards-closure.entity';
import { RewardsClientsService } from './rewards-clients.service';
import { RewardsCatalogController } from './rewards-catalog.controller';
import { RewardsController } from './rewards.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([PointsEntry, Redemption, RewardsClosure])],
  controllers: [RewardsCatalogController, RewardsController],
  providers: [RewardsService, RewardsClientsService, EventConsumerService, AccountClosedConsumer, JwtAuthGuard],
})
export class RewardsModule {}
