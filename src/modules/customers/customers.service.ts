import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProfileStorageService } from '../profile/storage/profile-storage.service';
import { SIGNED_URL_EXPIRY_SECONDS } from '../profile/profile.service';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { Prisma, Role } from '@prisma/client';

export interface CustomerProfileSummary {
  id: string;
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth: string;
  profileImageUrl: string | null;
}

export interface CustomerProfileDetail extends CustomerProfileSummary {
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CustomerCounts {
  addresses: number;
  planSelections: number;
}

export interface CustomerListItem {
  id: string;
  mobile: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  profile: CustomerProfileSummary | null;
  counts: CustomerCounts;
}

export interface CustomerListResponse {
  data: CustomerListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CustomerAddressDetail {
  id: string;
  userId: string;
  fullName: string;
  mobile: string;
  houseNumber: string;
  buildingName: string | null;
  streetName: string | null;
  landmark: string | null;
  stateId: string;
  cityId: string;
  areaId: string;
  state: string;
  city: string;
  area: string;
  pincode: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerPlanDetail {
  id: string;
  planType: string;
  status: string;
  frequency: string | null;
  quantity: number | null;
  quantityMode: string | null;
  quantityA: number | null;
  quantityB: number | null;
  startDate: Date | null;
  endDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerDetailResponse {
  id: string;
  mobile: string;
  email: string | null;
  emailVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
  profile: CustomerProfileDetail | null;
  addresses: CustomerAddressDetail[];
  plans: CustomerPlanDetail[];
}

@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: ProfileStorageService,
  ) {}

  /**
   * Retrieves a paginated list of customers with search and count metrics.
   * Only records with role=CUSTOMER are returned.
   */
  async getCustomers(query: QueryCustomersDto): Promise<CustomerListResponse> {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
    const skip = (page - 1) * limit;

    const trimmedSearch = query.search?.trim();

    const where: Prisma.UserWhereInput = {
      role: Role.CUSTOMER,
    };

    if (trimmedSearch) {
      const orConditions: Prisma.UserWhereInput[] = [
        { mobile: { contains: trimmedSearch, mode: 'insensitive' } },
        { email: { contains: trimmedSearch, mode: 'insensitive' } },
        {
          customerProfile: {
            firstName: { contains: trimmedSearch, mode: 'insensitive' },
          },
        },
        {
          customerProfile: {
            lastName: { contains: trimmedSearch, mode: 'insensitive' },
          },
        },
      ];

      const parts = trimmedSearch.split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        orConditions.push({
          customerProfile: {
            AND: [
              { firstName: { contains: parts[0], mode: 'insensitive' } },
              { lastName: { contains: parts.slice(1).join(' '), mode: 'insensitive' } },
            ],
          },
        });
      }

      where.OR = orConditions;
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          customerProfile: true,
          _count: {
            select: {
              addresses: true,
              planSelections: true,
            },
          },
        },
      }),
    ]);

    const data: CustomerListItem[] = await Promise.all(
      users.map(async (user) => {
        let profile: CustomerProfileSummary | null = null;

        if (user.customerProfile) {
          const profileImageUrl = await this.resolveProfileImageUrl(
            user.customerProfile.profileImagePath,
            user.id,
          );

          profile = {
            id: user.customerProfile.id,
            firstName: user.customerProfile.firstName,
            lastName: user.customerProfile.lastName,
            gender: user.customerProfile.gender,
            dateOfBirth: this.formatDate(user.customerProfile.dateOfBirth),
            profileImageUrl,
          };
        }

        return {
          id: user.id,
          mobile: user.mobile,
          email: user.email,
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          profile,
          counts: {
            addresses: user._count?.addresses ?? 0,
            planSelections: user._count?.planSelections ?? 0,
          },
        };
      }),
    );

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Retrieves full details for a single customer by User ID.
   * Throws 404 NotFoundException if the user does not exist or is not a CUSTOMER.
   */
  async getCustomerById(id: string): Promise<CustomerDetailResponse> {
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        role: Role.CUSTOMER,
      },
      include: {
        customerProfile: true,
        addresses: {
          orderBy: { createdAt: 'desc' },
        },
        planSelections: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`Customer with ID ${id} not found`);
    }

    const profileImageUrl = await this.resolveProfileImageUrl(
      user.customerProfile?.profileImagePath,
      user.id,
    );

    const profile: CustomerProfileDetail | null = user.customerProfile
      ? {
          id: user.customerProfile.id,
          firstName: user.customerProfile.firstName,
          lastName: user.customerProfile.lastName,
          gender: user.customerProfile.gender,
          dateOfBirth: this.formatDate(user.customerProfile.dateOfBirth),
          profileImageUrl,
          createdAt: user.customerProfile.createdAt,
          updatedAt: user.customerProfile.updatedAt,
        }
      : null;

    return {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      profile,
      addresses: (user.addresses ?? []).map((address) => ({
        id: address.id,
        userId: address.userId,
        fullName: address.fullName,
        mobile: address.mobile,
        houseNumber: address.houseNumber,
        buildingName: address.buildingName,
        streetName: address.streetName,
        landmark: address.landmark,
        stateId: address.stateId,
        cityId: address.cityId,
        areaId: address.areaId,
        state: address.state,
        city: address.city,
        area: address.area,
        pincode: address.pincode,
        latitude: address.latitude,
        longitude: address.longitude,
        createdAt: address.createdAt,
        updatedAt: address.updatedAt,
      })),
      plans: (user.planSelections ?? []).map((selection) => ({
        id: selection.id,
        planType: selection.planType,
        status: selection.status,
        frequency: selection.frequency,
        quantity: selection.quantity,
        quantityMode: selection.quantityMode,
        quantityA: selection.quantityA,
        quantityB: selection.quantityB,
        startDate: selection.startDate,
        endDate: selection.endDate,
        createdAt: selection.createdAt,
        updatedAt: selection.updatedAt,
      })),
    };
  }

  /**
   * Generates a temporary signed avatar URL if an image path is present.
   * Returns null if no image or if signing fails.
   */
  private async resolveProfileImageUrl(
    profileImagePath: string | null | undefined,
    userId: string,
  ): Promise<string | null> {
    if (!profileImagePath) {
      return null;
    }

    try {
      return await this.storageService.createSignedUrl(
        profileImagePath,
        SIGNED_URL_EXPIRY_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to generate signed avatar URL for user ${userId}: ${String(error)}`,
      );
      return null;
    }
  }

  private formatDate(date: Date | string | null | undefined): string {
    if (!date) return '';
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    return new Date(date).toISOString().split('T')[0];
  }
}
