// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard imported by the controller.
jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ManageDeliveryController } from "./manage-delivery.controller";
import { ManageDeliveryService } from "./manage-delivery.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ChangeQuantityDto } from "./dto/customer/change-quantity.dto";
import { SkipDeliveryDto } from "./dto/customer/skip-delivery.dto";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";

describe("ManageDeliveryController", () => {
  let controller: ManageDeliveryController;

  const mockService = {
    getManageDelivery: jest.fn().mockResolvedValue({ activePlan: {} }),
    skipDelivery: jest.fn().mockResolvedValue({ activePlan: {} }),
    changeQuantity: jest.fn().mockResolvedValue({ activePlan: {} }),
    changeSchedule: jest.fn().mockResolvedValue({ activePlan: {} }),
  };

  const jwtUser = {
    sub: "user-1",
    role: "CUSTOMER",
    sessionId: "session-1",
    type: "access" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ManageDeliveryController],
      providers: [{ provide: ManageDeliveryService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(ManageDeliveryController);
  });

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", ManageDeliveryController);
    expect(guards).toContain(JwtAuthGuard);
  });

  describe("endpoints use JWT.sub as identity (never a body userId)", () => {
    it("GET delegates with user.sub", async () => {
      await controller.getManageDelivery(jwtUser);
      expect(mockService.getManageDelivery).toHaveBeenCalledWith("user-1");
    });

    it("skip delegates with user.sub", async () => {
      await controller.skip(jwtUser, { deliveryDate: "2026-10-10" });
      expect(mockService.skipDelivery).toHaveBeenCalledWith("user-1", {
        deliveryDate: "2026-10-10",
      });
    });

    it("change-quantity delegates with user.sub", async () => {
      await controller.changeQuantity(jwtUser, { quantityLitres: 3 });
      expect(mockService.changeQuantity).toHaveBeenCalledWith("user-1", {
        quantityLitres: 3,
      });
    });

    it("change-schedule delegates with user.sub", async () => {
      const dto = { frequency: "DAILY", quantityMode: "FIXED", quantity: 2 } as any;
      await controller.changeSchedule(jwtUser, dto);
      expect(mockService.changeSchedule).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("DTO validation", () => {
    async function errorsFor(cls: any, payload: any) {
      return validate(plainToInstance(cls, payload));
    }

    it("accepts quantityLitres 1 and 5", async () => {
      expect(await errorsFor(ChangeQuantityDto, { quantityLitres: 1 })).toHaveLength(0);
      expect(await errorsFor(ChangeQuantityDto, { quantityLitres: 5 })).toHaveLength(0);
    });

    it("rejects quantityLitres 0 and 6", async () => {
      expect((await errorsFor(ChangeQuantityDto, { quantityLitres: 0 })).length).toBeGreaterThan(0);
      expect((await errorsFor(ChangeQuantityDto, { quantityLitres: 6 })).length).toBeGreaterThan(0);
    });

    it("rejects a malformed skip date", async () => {
      expect((await errorsFor(SkipDeliveryDto, { deliveryDate: "not-a-date" })).length).toBeGreaterThan(0);
    });
  });
});
