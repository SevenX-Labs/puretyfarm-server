import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { GeoapifyService, ResolvedLocation } from "./geoapify/geoapify.service";

export interface StateResponse {
  id: string;
  name: string;
}

export interface CityResponse {
  id: string;
  name: string;
  stateId: string;
}

export interface AreaResponse {
  id: string;
  name: string;
  cityId: string;
  pincode: string | null;
}

/**
 * Customer-facing location logic:
 *  - "detect" resolves GPS coordinates via Geoapify (no persistence).
 *  - the state/city/area readers expose only ACTIVE catalog entries and
 *    enforce the parent->child hierarchy so invalid combinations 404.
 */
@Injectable()
export class LocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geoapify: GeoapifyService,
  ) {}

  /**
   * Resolves a coordinate pair into a normalized location. Pure detection —
   * nothing is written to the database here.
   */
  async detectLocation(
    latitude: number,
    longitude: number,
  ): Promise<ResolvedLocation> {
    return this.geoapify.reverseGeocode(latitude, longitude);
  }

  /** Lists active states, alphabetically. */
  async getStates(): Promise<StateResponse[]> {
    const states = await this.prisma.state.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    });
    return states;
  }

  /**
   * Lists active cities for an active state. 404s if the state does not exist
   * or is inactive, so a city can never be read under an invalid state.
   */
  async getCities(stateId: string): Promise<CityResponse[]> {
    const state = await this.prisma.state.findFirst({
      where: { id: stateId, isActive: true },
      select: { id: true },
    });
    if (!state) {
      throw new NotFoundException("State not found");
    }

    return this.prisma.city.findMany({
      where: { stateId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, stateId: true },
    });
  }

  /**
   * Lists active areas for an active city. 404s if the city does not exist or
   * is inactive, enforcing the city->area hierarchy.
   */
  async getAreas(cityId: string): Promise<AreaResponse[]> {
    const city = await this.prisma.city.findFirst({
      where: { id: cityId, isActive: true },
      select: { id: true },
    });
    if (!city) {
      throw new NotFoundException("City not found");
    }

    return this.prisma.area.findMany({
      where: { cityId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, cityId: true, pincode: true },
    });
  }
}
