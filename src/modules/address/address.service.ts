import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CustomerAddress } from "@prisma/client";
import { CreateAddressDto } from "./dto/customer/create-address.dto";
import { UpdateAddressDto } from "./dto/customer/update-address.dto";
import { normalizeMobile } from "../../common/utils/phone.util";

/** Authoritative, active State -> City -> Area resolved from the catalog. */
interface ResolvedHierarchy {
  stateId: string;
  cityId: string;
  areaId: string;
  state: string;
  city: string;
  area: string;
  areaPincode: string | null;
}

@Injectable()
export class AddressService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a saved address for the authenticated customer. The State/City/Area
   * triple is validated against the active catalog and the display names are
   * resolved server-side from the IDs (never trusted from the client).
   */
  async createAddress(
    userId: string,
    dto: CreateAddressDto,
  ): Promise<CustomerAddress> {
    const hierarchy = await this.resolveHierarchy(
      dto.stateId,
      dto.cityId,
      dto.areaId,
    );

    // Canonicalize the mobile to the same +91XXXXXXXXXX format used across
    // Auth/User. Throws a 400 on an invalid number.
    const mobile = normalizeMobile(dto.mobile);

    return this.prisma.customerAddress.create({
      data: {
        userId,
        fullName: dto.fullName,
        mobile,
        houseNumber: dto.houseNumber,
        buildingName: dto.buildingName ?? null,
        streetName: dto.streetName ?? null,
        landmark: dto.landmark ?? null,
        stateId: hierarchy.stateId,
        cityId: hierarchy.cityId,
        areaId: hierarchy.areaId,
        state: hierarchy.state,
        city: hierarchy.city,
        area: hierarchy.area,
        // Prefer an explicit pincode, otherwise fall back to the area's pincode.
        pincode: dto.pincode ?? hierarchy.areaPincode,
        // Only persist coordinates that were actually provided (GPS). Manual
        // selection leaves these null rather than inventing a location.
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      },
    });
  }

  /** Returns all addresses owned by the authenticated customer. */
  async getAddresses(userId: string): Promise<CustomerAddress[]> {
    return this.prisma.customerAddress.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Returns a single address only if it belongs to the authenticated customer.
   * A non-owned or missing id both yield 404 so ownership is never disclosed
   * (IDOR protection).
   */
  async getAddress(userId: string, id: string): Promise<CustomerAddress> {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id, userId },
    });
    if (!address) {
      throw new NotFoundException("Address not found");
    }
    return address;
  }

  /**
   * Updates an owned address. If any location ID changes, the merged
   * State -> City -> Area triple is re-validated and the name snapshots are
   * re-resolved. Coordinates change only when valid values are supplied.
   */
  async updateAddress(
    userId: string,
    id: string,
    dto: UpdateAddressDto,
  ): Promise<CustomerAddress> {
    // Ownership check first (throws 404 if missing/not owned).
    const existing = await this.getAddress(userId, id);

    const data: Record<string, unknown> = {};

    if (dto.fullName !== undefined) data.fullName = dto.fullName;
    // Only touch mobile when supplied; canonicalize it (throws 400 if invalid).
    if (dto.mobile !== undefined) data.mobile = normalizeMobile(dto.mobile);
    if (dto.houseNumber !== undefined) data.houseNumber = dto.houseNumber;
    if (dto.buildingName !== undefined) data.buildingName = dto.buildingName;
    if (dto.streetName !== undefined) data.streetName = dto.streetName;
    if (dto.landmark !== undefined) data.landmark = dto.landmark;

    const locationChanged =
      dto.stateId !== undefined ||
      dto.cityId !== undefined ||
      dto.areaId !== undefined;

    if (locationChanged) {
      // Merge supplied IDs over the existing ones so a partial location update
      // is still validated as a complete, consistent triple.
      const hierarchy = await this.resolveHierarchy(
        dto.stateId ?? existing.stateId,
        dto.cityId ?? existing.cityId,
        dto.areaId ?? existing.areaId,
      );
      data.stateId = hierarchy.stateId;
      data.cityId = hierarchy.cityId;
      data.areaId = hierarchy.areaId;
      data.state = hierarchy.state;
      data.city = hierarchy.city;
      data.area = hierarchy.area;
      // Explicit pincode wins; otherwise adopt the new area's pincode.
      data.pincode = dto.pincode ?? hierarchy.areaPincode;
    } else if (dto.pincode !== undefined) {
      data.pincode = dto.pincode;
    }

    if (dto.latitude !== undefined) data.latitude = dto.latitude;
    if (dto.longitude !== undefined) data.longitude = dto.longitude;

    return this.prisma.customerAddress.update({
      where: { id },
      data,
    });
  }

  /**
   * Deletes an owned address. A non-owned or missing id yields 404 (IDOR
   * protection) rather than deleting another user's data.
   */
  async deleteAddress(userId: string, id: string): Promise<void> {
    // Ownership check first (throws 404 if missing/not owned).
    await this.getAddress(userId, id);
    await this.prisma.customerAddress.delete({ where: { id } });
  }

  /**
   * Validates that the given area belongs to the given city, the city belongs
   * to the given state, and every level is active. Throws BadRequestException
   * for any broken relationship or inactive entry, and returns the
   * authoritative names + area pincode.
   */
  private async resolveHierarchy(
    stateId: string,
    cityId: string,
    areaId: string,
  ): Promise<ResolvedHierarchy> {
    const area = await this.prisma.area.findUnique({
      where: { id: areaId },
      include: { city: { include: { state: true } } },
    });

    if (
      !area ||
      !area.isActive ||
      area.cityId !== cityId ||
      !area.city.isActive ||
      area.city.stateId !== stateId ||
      !area.city.state.isActive
    ) {
      throw new BadRequestException(
        "Invalid or inactive State -> City -> Area selection",
      );
    }

    return {
      stateId: area.city.state.id,
      cityId: area.city.id,
      areaId: area.id,
      state: area.city.state.name,
      city: area.city.name,
      area: area.name,
      areaPincode: area.pincode,
    };
  }
}
