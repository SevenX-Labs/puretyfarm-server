jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ManageDeliveryService } from "./manage-delivery.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import {
  PlanType,
  DeliveryFrequency,
  QuantityMode,
  DeliveryStatus,
  PlanSelectionStatus,
  ChangeRequestType,
  ChangeRequestStatus,
} from "../plans/plans.constants";

// ── Date helpers ──
function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
const TODAY = dateOnly(new Date());
function plusDays(n: number): Date {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

describe("ManageDeliveryService", () => {
  let service: ManageDeliveryService;

  const USER = "user-1";
  const ADMIN = "admin-1";

  const mockPrisma: any = {
    planSelection: { findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    planDelivery: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    planConfig: { findUnique: jest.fn() },
    manageDeliveryChangeRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const monthlySelection = {
    id: "sel-1",
    userId: USER,
    planType: PlanType.MONTHLY,
    status: PlanSelectionStatus.CONFIRMED,
    frequency: DeliveryFrequency.DAILY,
    quantityMode: QuantityMode.FIXED,
    quantity: 2,
    quantityA: null,
    quantityB: null,
    startDate: plusDays(-2),
    endDate: plusDays(5),
  };

  const deliveries = [
    { id: "d-past", deliveryDate: plusDays(-2), occurrence: 1, quantityLitres: 2, status: DeliveryStatus.DELIVERED },
    { id: "d-today", deliveryDate: plusDays(0), occurrence: 3, quantityLitres: 2, status: DeliveryStatus.SCHEDULED },
    { id: "d1", deliveryDate: plusDays(1), occurrence: 4, quantityLitres: 2, status: DeliveryStatus.SCHEDULED },
    { id: "d2", deliveryDate: plusDays(2), occurrence: 5, quantityLitres: 2, status: DeliveryStatus.SCHEDULED },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.planSelection.findFirst.mockResolvedValue(monthlySelection);
    mockPrisma.planSelection.update.mockResolvedValue(monthlySelection);
    mockPrisma.planSelection.findUnique.mockResolvedValue(monthlySelection);
    mockPrisma.planDelivery.findMany.mockResolvedValue(deliveries);
    mockPrisma.planDelivery.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.planDelivery.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.planDelivery.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue(null);
    mockPrisma.manageDeliveryChangeRequest.count.mockResolvedValue(0);
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        planSelection: mockPrisma.planSelection,
        planDelivery: mockPrisma.planDelivery,
        manageDeliveryChangeRequest: mockPrisma.manageDeliveryChangeRequest,
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ManageDeliveryService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(ManageDeliveryService);
  });

  // ══════════════════════════════════════════════════════════════
  //  GET
  // ══════════════════════════════════════════════════════════════

  describe("getManageDelivery", () => {
    it("returns the active plan and only upcoming deliveries", async () => {
      const res = await service.getManageDelivery(USER);
      expect(res.activePlan.planType).toBe(PlanType.MONTHLY);
      expect(res.activePlan.quantityLitres).toBe(2);
      expect(res.upcomingDeliveries).toHaveLength(3);
    });

    it("marks only strictly-future scheduled deliveries as modifiable", async () => {
      const res = await service.getManageDelivery(USER);
      const todayView = res.upcomingDeliveries.find(
        (d) => d.date === TODAY.toISOString().slice(0, 10),
      )!;
      const futureView = res.upcomingDeliveries.find(
        (d) => d.date === plusDays(1).toISOString().slice(0, 10),
      )!;
      expect(todayView.canSkip).toBe(false);
      expect(futureView.canSkip).toBe(true);
    });

    it("scopes lookup to authenticated user", async () => {
      await service.getManageDelivery(USER);
      expect(mockPrisma.planSelection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: USER }) }),
      );
    });

    it("throws NotFound when no active plan", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue(null);
      await expect(service.getManageDelivery(USER)).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  1. SKIP — applies immediately
  // ══════════════════════════════════════════════════════════════

  describe("skipDelivery", () => {
    it("skips a future delivery immediately (no approval)", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(deliveries[2]);
      const res = await service.skipDelivery(USER, {
        deliveryDate: plusDays(1).toISOString().slice(0, 10),
      });
      expect(res.success).toBe(true);
      expect(res.message).toBe("Delivery skipped successfully.");
      expect(mockPrisma.planDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: "d1", status: DeliveryStatus.SCHEDULED },
        data: { status: DeliveryStatus.SKIPPED },
      });
    });

    it("rejects a past date", async () => {
      await expect(
        service.skipDelivery(USER, { deliveryDate: plusDays(-1).toISOString().slice(0, 10) }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects today's delivery", async () => {
      await expect(
        service.skipDelivery(USER, { deliveryDate: TODAY.toISOString().slice(0, 10) }),
      ).rejects.toThrow(BadRequestException);
    });

    it("is race-safe: concurrent skip fails cleanly", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(deliveries[2]);
      mockPrisma.planDelivery.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.skipDelivery(USER, { deliveryDate: plusDays(1).toISOString().slice(0, 10) }),
      ).rejects.toThrow(BadRequestException);
    });

    it("scopes delivery lookup to authenticated user (IDOR protection)", async () => {
      mockPrisma.planDelivery.findFirst.mockResolvedValue(deliveries[2]);
      await service.skipDelivery(USER, { deliveryDate: plusDays(1).toISOString().slice(0, 10) });
      expect(mockPrisma.planDelivery.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: USER, selectionId: "sel-1" }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  2. PAUSE — applies immediately
  // ══════════════════════════════════════════════════════════════

  describe("pauseDelivery (approval-gated request)", () => {
    beforeEach(() => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue(null);
      mockPrisma.manageDeliveryChangeRequest.create.mockImplementation(
        ({ data }: any) => ({ id: "req-pause", createdAt: new Date(), ...data }),
      );
    });

    it("creates a PENDING PAUSE request and changes nothing live", async () => {
      const res = await service.pauseDelivery(USER, {});

      expect(res.success).toBe(true);
      const call = mockPrisma.manageDeliveryChangeRequest.create.mock.calls[0][0];
      expect(call.data.requestType).toBe(ChangeRequestType.PAUSE);
      expect(call.data.status).toBe(ChangeRequestStatus.PENDING);

      // The whole point: the live plan and its deliveries are untouched.
      expect(mockPrisma.planDelivery.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.planDelivery.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.planSelection.update).not.toHaveBeenCalled();
    });

    it("persists a validated resumeDate on the request", async () => {
      const resumeDate = plusDays(3).toISOString().slice(0, 10);
      await service.pauseDelivery(USER, { resumeDate });
      const call = mockPrisma.manageDeliveryChangeRequest.create.mock.calls[0][0];
      expect(call.data.requestedConfiguration.resumeDate).toBe(resumeDate);
    });

    it("rejects a past resumeDate", async () => {
      await expect(
        service.pauseDelivery(USER, {
          resumeDate: plusDays(-1).toISOString().slice(0, 10),
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.manageDeliveryChangeRequest.create).not.toHaveBeenCalled();
    });

    it("refuses a second pause request while one is pending", async () => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue({
        id: "req-existing",
        status: ChangeRequestStatus.PENDING,
      });
      await expect(service.pauseDelivery(USER, {})).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe("resumeDelivery (approval-gated request)", () => {
    beforeEach(() => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue(null);
      mockPrisma.manageDeliveryChangeRequest.create.mockImplementation(
        ({ data }: any) => ({ id: "req-resume", createdAt: new Date(), ...data }),
      );
    });

    it("creates a PENDING RESUME request for a PAUSED plan", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue({
        ...selection,
        status: PlanSelectionStatus.PAUSED,
      });

      const res = await service.resumeDelivery(USER);
      expect(res.success).toBe(true);
      const call = mockPrisma.manageDeliveryChangeRequest.create.mock.calls[0][0];
      expect(call.data.requestType).toBe(ChangeRequestType.RESUME);
      expect(call.data.status).toBe(ChangeRequestStatus.PENDING);
      // Status stays PAUSED until an admin approves.
      expect(mockPrisma.planSelection.update).not.toHaveBeenCalled();
    });

    it("rejects a resume when no paused plan exists", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue(null);
      await expect(service.resumeDelivery(USER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  3. CHANGE QUANTITY — creates PENDING request
  // ══════════════════════════════════════════════════════════════

  describe("changeQuantity", () => {
    it("creates a PENDING request instead of modifying active schedule", async () => {
      const mockRequest = {
        id: "req-1",
        requestType: ChangeRequestType.CHANGE_QUANTITY,
        status: ChangeRequestStatus.PENDING,
      };
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue(mockRequest);

      const res = await service.changeQuantity(USER, { quantityLitres: 3 });

      expect(res.success).toBe(true);
      expect(res.message).toContain("submitted for admin approval");
      expect(res.request.type).toBe(ChangeRequestType.CHANGE_QUANTITY);
      expect(res.request.status).toBe(ChangeRequestStatus.PENDING);
      expect(res.request.currentQuantity).toBe(2);
      expect(res.request.requestedQuantity).toBe(3);
    });

    it("does NOT modify PlanDelivery rows", async () => {
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue({
        id: "req-1",
        requestType: ChangeRequestType.CHANGE_QUANTITY,
        status: ChangeRequestStatus.PENDING,
      });

      await service.changeQuantity(USER, { quantityLitres: 3 });

      // The old direct-update pattern should not fire.
      expect(mockPrisma.planDelivery.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.planSelection.update).not.toHaveBeenCalled();
    });

    it("rejects duplicate pending quantity request", async () => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue({
        id: "existing",
        status: ChangeRequestStatus.PENDING,
      });

      await expect(
        service.changeQuantity(USER, { quantityLitres: 4 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  4. CHANGE FREQUENCY — creates PENDING request
  // ══════════════════════════════════════════════════════════════

  describe("changeFrequency", () => {
    it("creates a PENDING request", async () => {
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue({
        id: "req-2",
        requestType: ChangeRequestType.CHANGE_FREQUENCY,
        status: ChangeRequestStatus.PENDING,
      });

      const res = await service.changeFrequency(USER, {
        frequency: DeliveryFrequency.ALTERNATE_DAYS,
      });

      expect(res.success).toBe(true);
      expect(res.message).toContain("submitted for admin approval");
      expect(res.request.type).toBe(ChangeRequestType.CHANGE_FREQUENCY);
    });

    it("does NOT modify active schedule", async () => {
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue({
        id: "req-2",
        requestType: ChangeRequestType.CHANGE_FREQUENCY,
        status: ChangeRequestStatus.PENDING,
      });

      await service.changeFrequency(USER, {
        frequency: DeliveryFrequency.ALTERNATE_DAYS,
      });

      expect(mockPrisma.planDelivery.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.planDelivery.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.planSelection.update).not.toHaveBeenCalled();
    });

    it("rejects non-monthly plan", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue({
        ...monthlySelection,
        planType: PlanType.SEVEN_DAY_TRIAL,
      });
      await expect(
        service.changeFrequency(USER, { frequency: DeliveryFrequency.ALTERNATE_DAYS }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects same frequency", async () => {
      await expect(
        service.changeFrequency(USER, { frequency: DeliveryFrequency.DAILY }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects duplicate pending frequency request", async () => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue({
        id: "existing",
        status: ChangeRequestStatus.PENDING,
      });
      await expect(
        service.changeFrequency(USER, { frequency: DeliveryFrequency.ALTERNATE_DAYS }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  5. CHANGE PLAN — creates PENDING request
  // ══════════════════════════════════════════════════════════════

  describe("changePlan", () => {
    it("creates a PENDING request", async () => {
      mockPrisma.planConfig.findUnique.mockResolvedValue({
        planType: PlanType.BUY_ONCE,
        isActive: true,
      });
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue({
        id: "req-3",
        requestType: ChangeRequestType.CHANGE_PLAN,
        status: ChangeRequestStatus.PENDING,
      });

      const res = await service.changePlan(USER, { planType: PlanType.BUY_ONCE });

      expect(res.success).toBe(true);
      expect(res.message).toContain("submitted for admin approval");
      expect(res.request.type).toBe(ChangeRequestType.CHANGE_PLAN);
    });

    it("does NOT modify active plan", async () => {
      mockPrisma.planConfig.findUnique.mockResolvedValue({
        planType: PlanType.BUY_ONCE,
        isActive: true,
      });
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue({
        id: "req-3",
        requestType: ChangeRequestType.CHANGE_PLAN,
        status: ChangeRequestStatus.PENDING,
      });

      await service.changePlan(USER, { planType: PlanType.BUY_ONCE });

      expect(mockPrisma.planSelection.update).not.toHaveBeenCalled();
    });

    it("rejects same plan type", async () => {
      await expect(
        service.changePlan(USER, { planType: PlanType.MONTHLY }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects inactive target plan", async () => {
      mockPrisma.planConfig.findUnique.mockResolvedValue({
        planType: PlanType.BUY_ONCE,
        isActive: false,
      });
      await expect(
        service.changePlan(USER, { planType: PlanType.BUY_ONCE }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects nonexistent target plan", async () => {
      mockPrisma.planConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.changePlan(USER, { planType: PlanType.BUY_ONCE }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CUSTOMER — VIEW REQUESTS
  // ══════════════════════════════════════════════════════════════

  describe("getCustomerRequests", () => {
    it("returns formatted requests scoped to the user", async () => {
      mockPrisma.manageDeliveryChangeRequest.findMany.mockResolvedValue([
        {
          id: "req-1",
          requestType: ChangeRequestType.CHANGE_QUANTITY,
          status: ChangeRequestStatus.PENDING,
          currentConfiguration: { quantity: 2 },
          requestedConfiguration: { quantity: 3 },
          createdAt: new Date(),
          reviewedAt: null,
          adminNote: null,
        },
      ]);

      const res = await service.getCustomerRequests(USER);
      expect(res).toHaveLength(1);
      expect(res[0].message).toContain("pending admin approval");
    });

    it("scopes to the authenticated user only", async () => {
      mockPrisma.manageDeliveryChangeRequest.findMany.mockResolvedValue([]);
      await service.getCustomerRequests(USER);
      expect(mockPrisma.manageDeliveryChangeRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER } }),
      );
    });
  });

  describe("getCustomerRequest", () => {
    it("returns a single request for the user", async () => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue({
        id: "req-1",
        requestType: ChangeRequestType.CHANGE_QUANTITY,
        status: ChangeRequestStatus.REJECTED,
        currentConfiguration: { quantity: 2 },
        requestedConfiguration: { quantity: 3 },
        createdAt: new Date(),
        reviewedAt: new Date(),
        adminNote: "Capacity exceeded",
      });

      const res = await service.getCustomerRequest(USER, "req-1");
      expect(res.id).toBe("req-1");
      expect(res.message).toContain("rejected");
      expect(res.reason).toBe("Capacity exceeded");
    });

    it("throws NotFound when request belongs to another user", async () => {
      mockPrisma.manageDeliveryChangeRequest.findFirst.mockResolvedValue(null);
      await expect(
        service.getCustomerRequest(USER, "req-other"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ADMIN — APPROVE
  // ══════════════════════════════════════════════════════════════

  describe("approveRequest", () => {
    const pendingRequest = {
      id: "req-1",
      userId: USER,
      planSelectionId: "sel-1",
      requestType: ChangeRequestType.CHANGE_QUANTITY,
      status: ChangeRequestStatus.APPROVED,
      currentConfiguration: { quantity: 2 },
      requestedConfiguration: { quantityMode: QuantityMode.FIXED, quantity: 3 },
      adminId: ADMIN,
      reviewedAt: expect.any(Date),
    };

    it("approves and applies the quantity change", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue(pendingRequest);

      const res = await service.approveRequest(ADMIN, "req-1");

      expect(res.success).toBe(true);
      expect(res.request.status).toBe(ChangeRequestStatus.APPROVED);
      // Verify the quantity change was applied.
      expect(mockPrisma.planDelivery.updateMany).toHaveBeenCalled();
      expect(mockPrisma.planSelection.update).toHaveBeenCalled();
    });

    it("performs atomic PENDING→APPROVED transition (race-safe)", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue(pendingRequest);

      await service.approveRequest(ADMIN, "req-1");

      expect(mockPrisma.manageDeliveryChangeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: "req-1", status: ChangeRequestStatus.PENDING },
        data: expect.objectContaining({
          status: ChangeRequestStatus.APPROVED,
          adminId: ADMIN,
        }),
      });
    });

    it("rejects approval of already-approved request", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue({
        ...pendingRequest,
        status: ChangeRequestStatus.APPROVED,
      });

      await expect(
        service.approveRequest(ADMIN, "req-1"),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects approval of already-rejected request", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue({
        ...pendingRequest,
        status: ChangeRequestStatus.REJECTED,
      });

      await expect(
        service.approveRequest(ADMIN, "req-1"),
      ).rejects.toThrow(ConflictException);
    });

    it("throws NotFound for nonexistent request", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.approveRequest(ADMIN, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("stores adminId from function arg (not from request body)", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue(pendingRequest);

      await service.approveRequest("admin-specific-id", "req-1");

      expect(mockPrisma.manageDeliveryChangeRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ adminId: "admin-specific-id" }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ADMIN — REJECT
  // ══════════════════════════════════════════════════════════════

  describe("rejectRequest", () => {
    it("rejects with a note and does NOT modify active config", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.rejectRequest(ADMIN, "req-1", {
        note: "Capacity exceeded",
      });

      expect(res.success).toBe(true);
      expect(res.request.status).toBe(ChangeRequestStatus.REJECTED);
      expect(res.request.adminNote).toBe("Capacity exceeded");
      // Must NOT touch the active plan/schedule.
      expect(mockPrisma.planSelection.update).not.toHaveBeenCalled();
      expect(mockPrisma.planDelivery.updateMany).not.toHaveBeenCalled();
    });

    it("stores the admin note", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 1 });

      await service.rejectRequest(ADMIN, "req-1", {
        note: "Area capacity full",
      });

      expect(mockPrisma.manageDeliveryChangeRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ adminNote: "Area capacity full" }),
        }),
      );
    });

    it("prevents rejecting a non-PENDING request", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue({
        id: "req-1",
        status: ChangeRequestStatus.APPROVED,
      });

      await expect(
        service.rejectRequest(ADMIN, "req-1", { note: "reason" }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws NotFound for nonexistent request", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.manageDeliveryChangeRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.rejectRequest(ADMIN, "nonexistent", { note: "reason" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("adminId comes from JWT.sub, not request body", async () => {
      mockPrisma.manageDeliveryChangeRequest.updateMany.mockResolvedValue({ count: 1 });

      await service.rejectRequest("admin-xyz", "req-1", { note: "reason" });

      expect(mockPrisma.manageDeliveryChangeRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ adminId: "admin-xyz" }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  ADMIN — LIST REQUESTS
  // ══════════════════════════════════════════════════════════════

  describe("getAdminRequests", () => {
    it("returns paginated requests with customer info", async () => {
      mockPrisma.manageDeliveryChangeRequest.findMany.mockResolvedValue([
        {
          id: "req-1",
          requestType: ChangeRequestType.CHANGE_QUANTITY,
          status: ChangeRequestStatus.PENDING,
          currentConfiguration: {},
          requestedConfiguration: {},
          adminNote: null,
          reviewedAt: null,
          createdAt: new Date(),
          user: {
            id: USER,
            mobile: "9999999999",
            email: "test@test.com",
            customerProfile: { firstName: "Test", lastName: "User" },
          },
        },
      ]);
      mockPrisma.manageDeliveryChangeRequest.count.mockResolvedValue(1);

      const res = await service.getAdminRequests({});
      expect(res.data).toHaveLength(1);
      expect(res.data[0].customer.name).toBe("Test User");
      expect(res.pagination.total).toBe(1);
    });

    it("filters by status", async () => {
      mockPrisma.manageDeliveryChangeRequest.findMany.mockResolvedValue([]);
      mockPrisma.manageDeliveryChangeRequest.count.mockResolvedValue(0);

      await service.getAdminRequests({ status: ChangeRequestStatus.PENDING });

      expect(mockPrisma.manageDeliveryChangeRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: ChangeRequestStatus.PENDING }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  //  CHANGE SCHEDULE (legacy endpoint, now creates request)
  // ══════════════════════════════════════════════════════════════

  describe("changeSchedule", () => {
    it("creates a PENDING request instead of modifying schedule directly", async () => {
      mockPrisma.manageDeliveryChangeRequest.create.mockResolvedValue({
        id: "req-sch",
        requestType: ChangeRequestType.CHANGE_FREQUENCY,
        status: ChangeRequestStatus.PENDING,
      });

      const res = await service.changeSchedule(USER, {
        frequency: DeliveryFrequency.ALTERNATE_DAYS,
        quantityMode: QuantityMode.FIXED,
        quantity: 2,
      });

      expect(res.success).toBe(true);
      expect(res.message).toContain("submitted for admin approval");
      expect(mockPrisma.planDelivery.deleteMany).not.toHaveBeenCalled();
      expect(mockPrisma.planDelivery.createMany).not.toHaveBeenCalled();
    });

    it("rejects non-monthly plan", async () => {
      mockPrisma.planSelection.findFirst.mockResolvedValue({
        ...monthlySelection,
        planType: PlanType.SEVEN_DAY_TRIAL,
      });
      await expect(
        service.changeSchedule(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.FIXED,
          quantity: 2,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects ALTERNATING config missing quantityB", async () => {
      await expect(
        service.changeSchedule(USER, {
          frequency: DeliveryFrequency.DAILY,
          quantityMode: QuantityMode.ALTERNATING,
          quantityA: 1,
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
