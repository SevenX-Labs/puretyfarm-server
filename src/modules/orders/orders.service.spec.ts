import { Test, TestingModule } from "@nestjs/testing";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import { OrderStatus, PaymentStatus } from "./orders.constants";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  DeliveryStatus,
  PlanSelectionStatus,
} from "../plans/plans.constants";

const USER = "user-1";
const OTHER_USER = "user-2";
const ADMIN = "admin-1";

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
const TODAY = dateOnly(new Date());
function plusDays(n: number): Date {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const planConfig = {
  id: "config-1",
  planType: PlanType.MONTHLY,
  isActive: true,
  actualPricePerLitre: 9000,
  sellingPricePerLitre: 8000,
  quantityMin: 1,
  quantityMax: 5,
  deliveryFeePaise: 2000,
  deliveryStartTime: "08:00",
  deliveryEndTime: "10:00",
  maxUsages: 7,
  trialDurationDays: 7,
};

const selection = {
  id: "sel-1",
  userId: USER,
  planType: PlanType.MONTHLY,
  status: PlanSelectionStatus.ACTIVE,
  frequency: DeliveryFrequency.DAILY,
  quantityMode: QuantityMode.FIXED,
  quantity: 2,
  quantityA: null,
  quantityB: null,
  startDate: plusDays(-2),
  endDate: plusDays(5),
};

const delivery = {
  id: "del-1",
  selectionId: "sel-1",
  userId: USER,
  deliveryDate: plusDays(1),
  occurrence: 1,
  quantityLitres: 2,
  status: DeliveryStatus.SCHEDULED,
};

const address = {
  id: "addr-1",
  userId: USER,
  fullName: "Test User",
  mobile: "9999999999",
  houseNumber: "42",
  buildingName: "Test Bldg",
  streetName: "Main St",
  landmark: "Near Park",
  state: "Maharashtra",
  city: "Mumbai",
  area: "Andheri",
  pincode: "400001",
  latitude: null,
  longitude: null,
};

const existingOrder = {
  id: "order-1",
  orderNumber: "PF10001",
  userId: USER,
  planSelectionId: "sel-1",
  planDeliveryId: "del-1",
  planType: PlanType.MONTHLY,
  status: OrderStatus.DELIVERED,
  paymentStatus: PaymentStatus.PAID,
  subtotalPaise: 16000,
  discountPaise: 2000,
  taxPaise: 0,
  deliveryFeePaise: 2000,
  totalPaise: 18000,
  deliveryDate: plusDays(1),
  deliveryStartTime: "08:00",
  deliveryEndTime: "10:00",
  addressSnapshot: address,
  actualPricePerLitrePaise: 9000,
  sellingPricePerLitrePaise: 8000,
  reorderedFromOrderId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [
    {
      id: "item-1",
      orderId: "order-1",
      productId: null,
      productNameSnapshot: "Milk",
      quantity: 2,
      unitPricePaise: 8000,
      discountPaise: 2000,
      taxPaise: 0,
      totalPaise: 16000,
    },
  ],
  invoice: {
    id: "inv-1",
    invoiceNumber: "INV-10001",
    orderId: "order-1",
    financialSnapshot: {},
    addressSnapshot: address,
    issuedAt: new Date(),
  },
};

describe("OrdersService", () => {
  let service: OrdersService;

  const mockPrisma: any = {
    order: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    orderItem: {},
    invoice: {
      count: jest.fn(),
      create: jest.fn(),
    },
    planDelivery: { findFirst: jest.fn() },
    planSelection: { findFirst: jest.fn() },
    planConfig: { findUnique: jest.fn() },
    customerAddress: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.order.count.mockResolvedValue(0);
    mockPrisma.invoice.count.mockResolvedValue(0);
    mockPrisma.planConfig.findUnique.mockResolvedValue(planConfig);
    mockPrisma.planSelection.findFirst.mockResolvedValue(selection);
    mockPrisma.planDelivery.findFirst.mockResolvedValue(delivery);
    mockPrisma.customerAddress.findFirst.mockResolvedValue(address);
    mockPrisma.order.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(OrdersService);
  });

  // ══════════════════════════════════════════════════════════════
  //  ORDER CREATION
  // ══════════════════════════════════════════════════════════════

  describe("createOrder", () => {
    beforeEach(() => {
      mockPrisma.order.create.mockResolvedValue({
        ...existingOrder,
        id: "new-order",
        status: OrderStatus.CONFIRMED,
      });
      mockPrisma.invoice.create.mockResolvedValue(existingOrder.invoice);
    });

    it("creates an order from a SCHEDULED PlanDelivery", async () => {
      const res = await service.createOrder(USER, {
        planDeliveryId: "del-1",
        addressId: "addr-1",
      });
      expect(res.success).toBe(true);
      expect(mockPrisma.order.create).toHaveBeenCalled();
    });

    it("snapshots delivery fee from PlanConfig (not from client)", async () => {
      await service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.deliveryFeePaise).toBe(2000);
    });

    it("snapshots delivery time from PlanConfig", async () => {
      await service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.deliveryStartTime).toBe("08:00");
      expect(createCall.data.deliveryEndTime).toBe("10:00");
    });

    it("snapshots the address at order time", async () => {
      await service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.addressSnapshot.fullName).toBe("Test User");
      expect(createCall.data.addressSnapshot.city).toBe("Mumbai");
    });

    it("snapshots price per litre from PlanConfig", async () => {
      await service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.actualPricePerLitrePaise).toBe(9000);
      expect(createCall.data.sellingPricePerLitrePaise).toBe(8000);
    });

    it("creates an invoice alongside the order", async () => {
      await service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" });
      expect(mockPrisma.invoice.create).toHaveBeenCalled();
    });

    it("prevents duplicate order for the same PlanDelivery", async () => {
      mockPrisma.order.findUnique.mockResolvedValue(existingOrder);
      await expect(
        service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects if delivery does not belong to user (IDOR)", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(null);
      await expect(
        service.createOrder(USER, { planDeliveryId: "del-other", addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects if delivery is not SCHEDULED", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue({
        ...delivery,
        status: DeliveryStatus.SKIPPED,
      });
      await expect(
        service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects if address does not belong to user", async () => {
      mockPrisma.customerAddress.findFirst.mockResolvedValue(null);
      await expect(
        service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-other" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects if PlanConfig is inactive", async () => {
      mockPrisma.planConfig.findUnique.mockResolvedValue({ ...planConfig, isActive: false });
      await expect(
        service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("calculates total = subtotal + deliveryFee (integer paise)", async () => {
      await service.createOrder(USER, { planDeliveryId: "del-1", addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      const expected = 8000 * 2 + 2000; // selling * qty + fee
      expect(createCall.data.totalPaise).toBe(expected);
      expect(createCall.data.subtotalPaise).toBe(8000 * 2);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CUSTOMER — LIST ORDERS
  // ══════════════════════════════════════════════════════════════

  describe("getCustomerOrders", () => {
    it("scopes to the authenticated user", async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getCustomerOrders(USER, {});
      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER }),
        }),
      );
    });

    it("returns paginated results", async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(25);

      const res = await service.getCustomerOrders(USER, { page: 2, limit: 10 });
      expect(res.pagination.page).toBe(2);
      expect(res.pagination.total).toBe(25);
      expect(res.pagination.totalPages).toBe(3);
    });

    it("applies status filter", async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getCustomerOrders(USER, { status: OrderStatus.DELIVERED });
      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrderStatus.DELIVERED }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CUSTOMER — GET ONE ORDER
  // ══════════════════════════════════════════════════════════════

  describe("getCustomerOrder", () => {
    it("returns order for the authenticated user", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(existingOrder);
      const res = await service.getCustomerOrder(USER, "order-1");
      expect(res.orderNumber).toBe("PF10001");
    });

    it("throws NotFound when order belongs to another user (IDOR)", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);
      await expect(
        service.getCustomerOrder(USER, "order-other"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CUSTOMER — INVOICE
  // ══════════════════════════════════════════════════════════════

  describe("getCustomerInvoice", () => {
    it("returns invoice for own order", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(existingOrder);
      const res = await service.getCustomerInvoice(USER, "order-1");
      expect(res.invoiceNumber).toBe("INV-10001");
    });

    it("throws NotFound for another user's order", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);
      await expect(
        service.getCustomerInvoice(USER, "order-other"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFound when order has no invoice", async () => {
      mockPrisma.order.findFirst.mockResolvedValue({ ...existingOrder, invoice: null });
      await expect(
        service.getCustomerInvoice(USER, "order-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  REORDER
  // ══════════════════════════════════════════════════════════════

  describe("reorder", () => {
    beforeEach(() => {
      mockPrisma.order.findFirst.mockResolvedValue(existingOrder);
      mockPrisma.order.create.mockResolvedValue({
        ...existingOrder,
        id: "reorder-1",
        orderNumber: "PF10002",
        reorderedFromOrderId: "order-1",
        status: OrderStatus.PENDING,
      });
      mockPrisma.invoice.create.mockResolvedValue({
        ...existingOrder.invoice,
        id: "inv-2",
        invoiceNumber: "INV-10002",
      });
    });

    it("creates a new order using CURRENT pricing", async () => {
      const res = await service.reorder(USER, "order-1", { addressId: "addr-1" });
      expect(res.success).toBe(true);
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.sellingPricePerLitrePaise).toBe(planConfig.sellingPricePerLitre);
      expect(createCall.data.deliveryFeePaise).toBe(planConfig.deliveryFeePaise);
    });

    it("uses CURRENT delivery fee", async () => {
      await service.reorder(USER, "order-1", { addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.deliveryFeePaise).toBe(2000);
    });

    it("uses CURRENT delivery time", async () => {
      await service.reorder(USER, "order-1", { addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.deliveryStartTime).toBe("08:00");
      expect(createCall.data.deliveryEndTime).toBe("10:00");
    });

    it("stores reference to original order", async () => {
      await service.reorder(USER, "order-1", { addressId: "addr-1" });
      const createCall = mockPrisma.order.create.mock.calls[0][0];
      expect(createCall.data.reorderedFromOrderId).toBe("order-1");
    });

    it("rejects reorder of another user's order", async () => {
      mockPrisma.order.findFirst.mockResolvedValue(null);
      await expect(
        service.reorder(USER, "order-other", { addressId: "addr-1" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects reorder of pending order", async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.PENDING,
      });
      await expect(
        service.reorder(USER, "order-1", { addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects reorder of cancelled order", async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.CANCELLED,
      });
      await expect(
        service.reorder(USER, "order-1", { addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects reorder of failed order", async () => {
      mockPrisma.order.findFirst.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.FAILED,
      });
      await expect(
        service.reorder(USER, "order-1", { addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects if plan type is no longer active", async () => {
      mockPrisma.planConfig.findUnique.mockResolvedValue({ ...planConfig, isActive: false });
      await expect(
        service.reorder(USER, "order-1", { addressId: "addr-1" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("does not modify original order", async () => {
      await service.reorder(USER, "order-1", { addressId: "addr-1" });
      expect(mockPrisma.order.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "order-1" } }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ADMIN — LIST ORDERS
  // ══════════════════════════════════════════════════════════════

  describe("getAdminOrders", () => {
    it("returns paginated results with customer info", async () => {
      mockPrisma.order.findMany.mockResolvedValue([
        {
          ...existingOrder,
          user: {
            id: USER,
            mobile: "9999999999",
            email: "test@test.com",
            customerProfile: { firstName: "Test", lastName: "User" },
          },
        },
      ]);
      mockPrisma.order.count.mockResolvedValue(1);

      const res = await service.getAdminOrders({});
      expect(res.data).toHaveLength(1);
      expect(res.data[0].customer.name).toBe("Test User");
    });

    it("filters by status", async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getAdminOrders({ status: OrderStatus.PENDING });
      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrderStatus.PENDING }),
        }),
      );
    });

    it("filters by payment status", async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.getAdminOrders({ paymentStatus: PaymentStatus.PAID });
      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ paymentStatus: PaymentStatus.PAID }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ADMIN — GET ONE ORDER
  // ══════════════════════════════════════════════════════════════

  describe("getAdminOrder", () => {
    it("returns full order detail", async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...existingOrder,
        user: {
          id: USER,
          mobile: "9999999999",
          email: "test@test.com",
          customerProfile: { firstName: "Test", lastName: "User" },
        },
      });

      const res = await service.getAdminOrder("order-1");
      expect(res.orderNumber).toBe("PF10001");
      expect(res.customer.name).toBe("Test User");
    });

    it("throws NotFound for nonexistent order", async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      await expect(service.getAdminOrder("nonexistent")).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ADMIN — UPDATE STATUS
  // ══════════════════════════════════════════════════════════════

  describe("updateOrderStatus", () => {
    it("allows valid status transition PENDING → CONFIRMED", async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.PENDING,
      });
      mockPrisma.order.update.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.CONFIRMED,
        items: existingOrder.items,
        invoice: existingOrder.invoice,
      });

      const res = await service.updateOrderStatus("order-1", {
        status: OrderStatus.CONFIRMED,
      });
      expect(res.success).toBe(true);
      expect(res.order.status).toBe(OrderStatus.CONFIRMED);
    });

    it("allows CONFIRMED → PROCESSING", async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.CONFIRMED,
      });
      mockPrisma.order.update.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.PROCESSING,
        items: existingOrder.items,
        invoice: existingOrder.invoice,
      });

      const res = await service.updateOrderStatus("order-1", {
        status: OrderStatus.PROCESSING,
      });
      expect(res.order.status).toBe(OrderStatus.PROCESSING);
    });

    it("rejects invalid transition DELIVERED → PENDING", async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.DELIVERED,
      });

      await expect(
        service.updateOrderStatus("order-1", { status: OrderStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid transition CANCELLED → CONFIRMED", async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.CANCELLED,
      });

      await expect(
        service.updateOrderStatus("order-1", { status: OrderStatus.CONFIRMED }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFound for nonexistent order", async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      await expect(
        service.updateOrderStatus("nonexistent", { status: OrderStatus.CONFIRMED }),
      ).rejects.toThrow(NotFoundException);
    });

    it("does not modify pricing/snapshots on status update", async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.PENDING,
      });
      mockPrisma.order.update.mockResolvedValue({
        ...existingOrder,
        status: OrderStatus.CONFIRMED,
        items: existingOrder.items,
        invoice: existingOrder.invoice,
      });

      await service.updateOrderStatus("order-1", { status: OrderStatus.CONFIRMED });
      const updateCall = mockPrisma.order.update.mock.calls[0][0];
      expect(updateCall.data).toEqual({ status: OrderStatus.CONFIRMED });
    });
  });
});
