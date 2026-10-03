import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, Role, User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByMobile(mobile: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { mobile },
    });
  }

  async findById(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async createCustomer(mobile: string): Promise<User> {
    return this.prisma.user.create({
      data: {
        mobile,
        role: Role.CUSTOMER,
      },
    });
  }

  /**
   * Returns the customer for `mobile`, creating one if none exists.
   *
   * Concurrency-safe: if two requests race to create the same mobile, the
   * database unique constraint rejects the second create (P2002) and we
   * re-fetch the winner's record instead of surfacing an internal error.
   */
  async findOrCreateByMobile(mobile: string): Promise<User> {
    const existing = await this.findByMobile(mobile);
    if (existing) {
      return existing;
    }

    try {
      return await this.createCustomer(mobile);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.findByMobile(mobile);
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  async updateEmail(
    userId: string,
    email: string,
    emailVerified = true,
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        email,
        emailVerified,
      },
    });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }
}
