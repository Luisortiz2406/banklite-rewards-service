import { Controller, Get } from '@nestjs/common';
import { rewardsCatalog } from './catalog';

/** Puntos Banklite, públicos (sin sesión): los usan la página de puntos, los términos y Banki. */
@Controller('rewards')
export class RewardsCatalogController {
  @Get('catalog')
  catalog() {
    return rewardsCatalog();
  }
}
