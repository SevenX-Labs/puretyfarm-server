import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { LocationsService } from "./locations.service";
import { DetectLocationDto } from "./dto/customer/detect-location.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { JwtPayload } from "../../common/interfaces/jwt-payload.interface";

/**
 * Customer-side location APIs. All endpoints require a valid customer JWT.
 * These are READ-ONLY with respect to the location catalog — customers can
 * never create or mutate States/Cities/Areas here.
 */
@Controller(["api/v1/customer/locations", "customer/locations"])
@UseGuards(JwtAuthGuard)
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  /**
   * Reverse-geocodes the device's current GPS coordinates. Returns resolved
   * location data only — it does NOT create an address.
   */
  @Post("detect")
  @HttpCode(HttpStatus.OK)
  async detect(
    @CurrentUser() user: JwtPayload,
    @Body() dto: DetectLocationDto,
  ) {
    // Identity for rate limiting + caching comes from the JWT, never the body.
    return this.locationsService.detectLocation(
      user.sub,
      dto.latitude,
      dto.longitude,
    );
  }

  @Get("states")
  @HttpCode(HttpStatus.OK)
  async getStates() {
    return this.locationsService.getStates();
  }

  @Get("states/:stateId/cities")
  @HttpCode(HttpStatus.OK)
  async getCities(
    @Param("stateId", new ParseUUIDPipe()) stateId: string,
  ) {
    return this.locationsService.getCities(stateId);
  }

  @Get("cities/:cityId/areas")
  @HttpCode(HttpStatus.OK)
  async getAreas(@Param("cityId", new ParseUUIDPipe()) cityId: string) {
    return this.locationsService.getAreas(cityId);
  }
}
