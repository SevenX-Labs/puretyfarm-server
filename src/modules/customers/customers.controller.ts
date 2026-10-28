import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { QueryCustomersDto } from './dto/query-customers.dto';
import { UpdateMembershipDto } from './dto/update-membership.dto';
import { BulkUpdateMembershipDto } from './dto/bulk-update-membership.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@Controller(['api/v1/admin/customers', 'admin/customers'])
@UseGuards(JwtAuthGuard)
@Roles('ADMIN')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  async getCustomers(@Query() query: QueryCustomersDto) {
    return this.customersService.getCustomers(query);
  }

  @Patch('bulk/membership')
  async bulkUpdateMembership(@Body() dto: BulkUpdateMembershipDto) {
    return this.customersService.bulkUpdateMembership(
      dto.customerIds,
      dto.membershipType,
    );
  }

  @Get(':id')
  async getCustomerById(@Param('id') id: string) {
    return this.customersService.getCustomerById(id);
  }

  @Patch(':id/membership')
  async updateMembership(
    @Param('id') id: string,
    @Body() dto: UpdateMembershipDto,
  ) {
    return this.customersService.updateMembership(id, dto.membershipType);
  }
}
