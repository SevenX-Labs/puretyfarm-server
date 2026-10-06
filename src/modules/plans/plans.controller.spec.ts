// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard imported by the controller.
jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { PlansController } from "./plans.controller";
import { PlansService } from "./plans.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { BuyOnceQuoteDto } from "./dto/customer/buy-once-quote.dto";
import { TrialQuoteDto } from "./dto/customer/trial-quote.dto";
import { MonthlyQuoteDto } from "./dto/customer/monthly-quote.dto";
import { ConfirmPlanDto, PlanPaymentMethod } from "./dto/customer/confirm-plan.dto";
import { DeliveryFrequency, QuantityMode } from "./plans.constants";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";

describe("PlansController", () => {
  let controller: PlansController;

  const mockPlansService = {
    getPlansOverview: jest.fn().mockResolvedValue({ plans: [] }),
    getBuyOnceEligibility: jest.fn().mockResolvedValue({ eligible: true }),
    createBuyOnceQuote: jest.fn().mockResolvedValue({ quoteId: "q-1" }),
    getTrialEligibility: jest.fn().mockResolvedValue({ eligible: true }),
    createTrialQuote: jest.fn().mockResolvedValue({ quoteId: "q-2" }),
    getMonthlyInfo: jest.fn().mockResolvedValue({ available: true }),
    createMonthlyQuote: jest.fn().mockResolvedValue({ quoteId: "q-3" }),
    confirmPlan: jest.fn().mockResolvedValue({ selectionId: "s-1" }),
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
      controllers: [PlansController],
      providers: [
        {
          provide: PlansService,
          useValue: mockPlansService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PlansController>(PlansController);
  });

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", PlansController);
    expect(guards).toContain(JwtAuthGuard);
  });

  describe("Endpoints delegate to PlansService using JWT.sub identity", () => {
    it("getPlans delegates with user.sub", async () => {
      await controller.getPlans(jwtUser);
      expect(mockPlansService.getPlansOverview).toHaveBeenCalledWith("user-1");
    });

    it("buyOnceEligibility delegates with user.sub", async () => {
      await controller.buyOnceEligibility(jwtUser);
      expect(mockPlansService.getBuyOnceEligibility).toHaveBeenCalledWith("user-1");
    });

    it("buyOnceQuote delegates with user.sub and dto", async () => {
      const dto = { quantityLitres: 2 };
      await controller.buyOnceQuote(jwtUser, dto);
      expect(mockPlansService.createBuyOnceQuote).toHaveBeenCalledWith("user-1", dto);
    });

    it("trialEligibility delegates with user.sub", async () => {
      await controller.trialEligibility(jwtUser);
      expect(mockPlansService.getTrialEligibility).toHaveBeenCalledWith("user-1");
    });

    it("trialQuote delegates with user.sub and dto", async () => {
      const dto = { quantityLitres: 1 };
      await controller.trialQuote(jwtUser, dto);
      expect(mockPlansService.createTrialQuote).toHaveBeenCalledWith("user-1", dto);
    });

    it("monthly delegates without user params", async () => {
      await controller.monthly();
      expect(mockPlansService.getMonthlyInfo).toHaveBeenCalled();
    });

    it("monthlyQuote delegates with user.sub and dto", async () => {
      const dto: MonthlyQuoteDto = {
        frequency: DeliveryFrequency.DAILY,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      };
      await controller.monthlyQuote(jwtUser, dto);
      expect(mockPlansService.createMonthlyQuote).toHaveBeenCalledWith("user-1", dto);
    });

    it("confirm delegates with user.sub and dto", async () => {
      const dto = { quoteId: "550e8400-e29b-41d4-a716-446655440000", paymentMethod: PlanPaymentMethod.WALLET };
      await controller.confirm(jwtUser, dto);
      expect(mockPlansService.confirmPlan).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("DTO Validations", () => {
    describe("BuyOnceQuoteDto", () => {
      it("accepts valid quantity (1 to 5)", async () => {
        for (const qty of [1, 2, 3, 4, 5]) {
          const dto = plainToInstance(BuyOnceQuoteDto, { quantityLitres: qty });
          const errors = await validate(dto);
          expect(errors.length).toBe(0);
        }
      });

      it("rejects 0 quantity", async () => {
        const dto = plainToInstance(BuyOnceQuoteDto, { quantityLitres: 0 });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });

      it("rejects > 5 quantity", async () => {
        const dto = plainToInstance(BuyOnceQuoteDto, { quantityLitres: 6 });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });

      it("rejects non-integer quantity", async () => {
        const dto = plainToInstance(BuyOnceQuoteDto, { quantityLitres: 2.5 });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    });

    describe("TrialQuoteDto", () => {
      it("accepts valid quantity (1 to 5)", async () => {
        const dto = plainToInstance(TrialQuoteDto, { quantityLitres: 3 });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      });

      it("rejects 0 quantity", async () => {
        const dto = plainToInstance(TrialQuoteDto, { quantityLitres: 0 });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });

      it("rejects 6 quantity", async () => {
        const dto = plainToInstance(TrialQuoteDto, { quantityLitres: 6 });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });

      it("rejects non-integer quantity", async () => {
        const dto = plainToInstance(TrialQuoteDto, { quantityLitres: 1.5 });
        const errors = await validate(dto);
        expect(errors.length).toBeGreaterThan(0);
      });
    });

    describe("MonthlyQuoteDto", () => {
      it("accepts valid DAILY + FIXED", async () => {
        const dto = plainToInstance(MonthlyQuoteDto, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
          quantity: 2,
        });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      });

      it("accepts valid ALTERNATE_DAYS + ALTERNATING", async () => {
        const dto = plainToInstance(MonthlyQuoteDto, {
          frequency: DeliveryFrequency.ALTERNATE_DAYS,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 1,
          quantityB: 3,
        });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      });

      it("rejects FIXED without quantity", async () => {
        const dto = plainToInstance(MonthlyQuoteDto, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "quantity")).toBe(true);
      });

      it("rejects ALTERNATING without quantityB", async () => {
        const dto = plainToInstance(MonthlyQuoteDto, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 2,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "quantityB")).toBe(true);
      });

      it("rejects invalid frequency", async () => {
        const dto = plainToInstance(MonthlyQuoteDto, {
          frequency: "HOURLY" as any,
          quantityMode: QuantityMode.FIXED,
          quantity: 1,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "frequency")).toBe(true);
      });

      it("rejects invalid quantityMode", async () => {
        const dto = plainToInstance(MonthlyQuoteDto, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: "RANDOM" as any,
          quantity: 1,
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "quantityMode")).toBe(true);
      });
    });

    describe("ConfirmPlanDto", () => {
      it("accepts valid UUID with WALLET payment method", async () => {
        const dto = plainToInstance(ConfirmPlanDto, {
          quoteId: "123e4567-e89b-42d3-a456-426614174000",
          paymentMethod: "WALLET",
        });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      });

      it("accepts valid UUID with CASH payment method", async () => {
        const dto = plainToInstance(ConfirmPlanDto, {
          quoteId: "123e4567-e89b-42d3-a456-426614174000",
          paymentMethod: "CASH",
        });
        const errors = await validate(dto);
        expect(errors.length).toBe(0);
      });

      it("rejects non-UUID quoteId", async () => {
        const dto = plainToInstance(ConfirmPlanDto, {
          quoteId: "not-a-uuid",
          paymentMethod: "WALLET",
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "quoteId")).toBe(true);
      });

      it("rejects missing paymentMethod", async () => {
        const dto = plainToInstance(ConfirmPlanDto, {
          quoteId: "123e4567-e89b-42d3-a456-426614174000",
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "paymentMethod")).toBe(true);
      });

      it("rejects invalid paymentMethod", async () => {
        const dto = plainToInstance(ConfirmPlanDto, {
          quoteId: "123e4567-e89b-42d3-a456-426614174000",
          paymentMethod: "ONLINE",
        });
        const errors = await validate(dto);
        expect(errors.some((e) => e.property === "paymentMethod")).toBe(true);
      });
    });
  });
});
