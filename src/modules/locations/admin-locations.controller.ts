import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { LocationsService } from './locations.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateStateDto } from './dto/admin/create-state.dto';
import { UpdateStateDto } from './dto/admin/update-state.dto';
import { CreateCityDto } from './dto/admin/create-city.dto';
import { UpdateCityDto } from './dto/admin/update-city.dto';
import { CreateAreaDto } from './dto/admin/create-area.dto';
import { UpdateAreaDto } from './dto/admin/update-area.dto';

/**
 * Admin-side location catalog management. Lives in the SAME LocationsModule as
 * the customer controller and shares the SAME LocationsService, so admin edits
 * flow straight into customer serviceability.
 *
 * Every route requires an ADMIN JWT: JwtAuthGuard authenticates and @Roles
 * enforces the ADMIN role, so a customer token receives 403. Unlike the
 * customer read endpoints, the list endpoints here return inactive records too.
 */
@Controller(['api/v1/admin/locations', 'admin/locations'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class AdminLocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  // ----- States -------------------------------------------------------------

  @Post('states')
  @HttpCode(HttpStatus.CREATED)
  async createState(@Body() dto: CreateStateDto) {
    return this.locationsService.createState(dto);
  }

  @Get('states')
  @HttpCode(HttpStatus.OK)
  async getStates() {
    return this.locationsService.getAdminStates();
  }

  @Patch('states/:stateId')
  @HttpCode(HttpStatus.OK)
  async updateState(
    @Param('stateId', new ParseUUIDPipe()) stateId: string,
    @Body() dto: UpdateStateDto,
  ) {
    return this.locationsService.updateState(stateId, dto);
  }

  @Delete('states/:stateId')
  @HttpCode(HttpStatus.OK)
  async deleteState(@Param('stateId', new ParseUUIDPipe()) stateId: string) {
    return this.locationsService.deleteState(stateId);
  }

  // ----- Cities -------------------------------------------------------------

  @Post('cities')
  @HttpCode(HttpStatus.CREATED)
  async createCity(@Body() dto: CreateCityDto) {
    return this.locationsService.createCity(dto);
  }

  @Get('states/:stateId/cities')
  @HttpCode(HttpStatus.OK)
  async getCities(@Param('stateId', new ParseUUIDPipe()) stateId: string) {
    return this.locationsService.getAdminCities(stateId);
  }

  @Patch('cities/:cityId')
  @HttpCode(HttpStatus.OK)
  async updateCity(
    @Param('cityId', new ParseUUIDPipe()) cityId: string,
    @Body() dto: UpdateCityDto,
  ) {
    return this.locationsService.updateCity(cityId, dto);
  }

  @Delete('cities/:cityId')
  @HttpCode(HttpStatus.OK)
  async deleteCity(@Param('cityId', new ParseUUIDPipe()) cityId: string) {
    return this.locationsService.deleteCity(cityId);
  }

  // ----- Areas --------------------------------------------------------------

  @Post('areas')
  @HttpCode(HttpStatus.CREATED)
  async createArea(@Body() dto: CreateAreaDto) {
    return this.locationsService.createArea(dto);
  }

  @Get('cities/:cityId/areas')
  @HttpCode(HttpStatus.OK)
  async getAreas(@Param('cityId', new ParseUUIDPipe()) cityId: string) {
    return this.locationsService.getAdminAreas(cityId);
  }

  @Patch('areas/:areaId')
  @HttpCode(HttpStatus.OK)
  async updateArea(
    @Param('areaId', new ParseUUIDPipe()) areaId: string,
    @Body() dto: UpdateAreaDto,
  ) {
    return this.locationsService.updateArea(areaId, dto);
  }

  @Delete('areas/:areaId')
  @HttpCode(HttpStatus.OK)
  async deleteArea(@Param('areaId', new ParseUUIDPipe()) areaId: string) {
    return this.locationsService.deleteArea(areaId);
  }
}
