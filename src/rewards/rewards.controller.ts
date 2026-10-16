import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RewardsService } from './rewards.service';

class RedeemDto {
  @Matches(/^[a-z0-9]{2,20}$/, { message: 'rewardId no es válido.' })
  rewardId: string;

  // Se genera al confirmar el canje: un doble clic manda la misma clave.
  @IsUUID()
  idempotencyKey: string;

  // Solo recargas: operador del celular verificado.
  @IsOptional()
  @Matches(/^rec-[a-z]{2,20}$/, { message: 'Operador no válido.' })
  operatorCode?: string;
}

const userOf = (request: Request): string => (request as any).user.idUser;
const tokenOf = (request: Request): string => (request as any).accessToken;

/** Puntos Banklite del cliente. */
@Controller('rewards')
@UseGuards(JwtAuthGuard)
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @Get()
  summary(@Req() request: Request) {
    return this.rewards.summary(userOf(request), tokenOf(request));
  }

  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  redeem(@Body() dto: RedeemDto, @Req() request: Request) {
    return this.rewards.redeem(userOf(request), tokenOf(request), dto.rewardId, dto.idempotencyKey, dto.operatorCode);
  }
}
