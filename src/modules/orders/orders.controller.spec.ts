jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { OrdersController } from "./orders.controller";
import { AdminOrdersController } from "./admin-orders.controller";
import { OrdersService } from "./orders.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateOrderDto } from "./dto/customer/create-order.dto";
import { ReorderDto } from "./dto/customer/reorder.dto";
import { UpdateOrderStatusDto } from "./dto/admin/update-order-status.dto";

describe("OrdersController (Customer)", () => {
  let controller: OrdersController;

  const mockService = {
    getCustomerOrders: jest.fn().mockResolvedValue({ data: [] }),
    getCustomerOrder: jest.fn().mockResolvedValue({}),
    createOrder: jest.fn().mockResolvedValue({ success: true }),
    reorder: jest.fn().mockResolvedValue({ success: true }),
    getCustomerInvoice: jest.fn().mockResolvedValue({}),
  };

  const customerJwt = {
    sub: "user-1",
    role: "CUSTOMER",
    sessionId: "session-1",
    type: "access" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: OrdersService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(OrdersController);
  });

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", OrdersController);
    expect(guards).toContain(JwtAuthGuard);
  });

  describe("endpoints use JWT.sub as identity", () => {
    it("listOrders uses user.sub", async () => {
      await controller.listOrders(customerJwt, {});
      expect(mockService.getCustomerOrders).toHaveBeenCalledWith("user-1", {});
    });

    it("getOrder uses user.sub", async () => {
      await controller.getOrder(customerJwt, "order-1");
      expect(mockService.getCustomerOrder).toHaveBeenCalledWith("user-1", "order-1");
    });

    it("createOrder uses user.sub", async () => {
      const dto = { planDeliveryId: "del-1", addressId: "addr-1" };
      await controller.createOrder(customerJwt, dto);
      expect(mockService.createOrder).toHaveBeenCalledWith("user-1", dto);
    });

    it("reorder uses user.sub", async () => {
      await controller.reorder(customerJwt, "order-1", { addressId: "addr-1" });
      expect(mockService.reorder).toHaveBeenCalledWith("user-1", "order-1", {
        addressId: "addr-1",
      });
    });

    it("getInvoice uses user.sub", async () => {
      await controller.getInvoice(customerJwt, "order-1");
      expect(mockService.getCustomerInvoice).toHaveBeenCalledWith("user-1", "order-1");
    });
  });

  describe("DTO validation", () => {
    async function errorsFor(cls: any, payload: any) {
      return validate(plainToInstance(cls, payload));
    }

    it("CreateOrderDto requires valid UUIDs", async () => {
      expect(
        (await errorsFor(CreateOrderDto, { planDeliveryId: "bad", addressId: "bad" })).length,
      ).toBeGreaterThan(0);
    });

    it("ReorderDto requires valid addressId", async () => {
      expect(
        (await errorsFor(ReorderDto, { addressId: "not-uuid" })).length,
      ).toBeGreaterThan(0);
    });

    it("UpdateOrderStatusDto rejects invalid status", async () => {
      expect(
        (await errorsFor(UpdateOrderStatusDto, { status: "FLYING" })).length,
      ).toBeGreaterThan(0);
    });

    it("UpdateOrderStatusDto accepts valid status", async () => {
      expect(
        await errorsFor(UpdateOrderStatusDto, { status: "CONFIRMED" }),
      ).toHaveLength(0);
    });
  });
});

describe("AdminOrdersController", () => {
  let adminController: AdminOrdersController;

  const mockService = {
    getAdminOrders: jest.fn().mockResolvedValue({ data: [] }),
    getAdminOrder: jest.fn().mockResolvedValue({}),
    updateOrderStatus: jest.fn().mockResolvedValue({ success: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminOrdersController],
      providers: [{ provide: OrdersService, useValue: mockService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    adminController = module.get(AdminOrdersController);
  });

  it("is protected by JwtAuthGuard", () => {
    const guards = Reflect.getMetadata("__guards__", AdminOrdersController);
    expect(guards).toContain(JwtAuthGuard);
  });

  it("requires ADMIN role", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminOrdersController);
    expect(roles).toContain("ADMIN");
  });

  it("customer token cannot access (role check)", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminOrdersController);
    expect(roles).not.toContain("CUSTOMER");
  });

  it("listOrders delegates to service", async () => {
    await adminController.listOrders({});
    expect(mockService.getAdminOrders).toHaveBeenCalledWith({});
  });

  it("getOrder delegates to service", async () => {
    await adminController.getOrder("order-1");
    expect(mockService.getAdminOrder).toHaveBeenCalledWith("order-1");
  });

  it("updateStatus delegates to service", async () => {
    await adminController.updateStatus("order-1", { status: "CONFIRMED" as any });
    expect(mockService.updateOrderStatus).toHaveBeenCalledWith("order-1", {
      status: "CONFIRMED",
    });
  });
});
