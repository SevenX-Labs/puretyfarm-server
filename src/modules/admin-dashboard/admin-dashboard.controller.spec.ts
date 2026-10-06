import { Test, TestingModule } from '@nestjs/testing';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';

describe('AdminDashboardController', () => {
  let controller: AdminDashboardController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminDashboardController],
      providers: [AdminDashboardService],
    }).compile();

    controller = module.get<AdminDashboardController>(AdminDashboardController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
