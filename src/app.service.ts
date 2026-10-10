import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async checkDbConnection() {
    const result = await this.prisma.$queryRaw<
      Array<{ status: number; now: Date }>
    >`SELECT 1 as status, NOW() as now`;
    return {
      status: 'ok',
      message: 'Database connection is healthy',
      databaseTime: result[0]?.now,
    };
  }
}
