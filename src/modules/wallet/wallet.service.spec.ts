jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        // WALLET_AUTO_CREDIT_ENABLED is intentionally absent — auto-credit is
        // per-wallet (`Wallet.autoCreditEnabled`), not an env flag.
        WALLET_CREDIT_MIN_PAISE: "100",
        WALLET_CREDIT_MAX_PAISE: "1000000",
      };
      return map[key];
    }),
  })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { WalletService } from "./wallet.service";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import {
  WalletCreditRequestStatus,
  WalletRefundStatus,
  WalletTransactionType,
  WalletTransactionReferenceType,
} from "./wallet.constants";

function makeMockPrisma() {
  return {
    wallet: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    walletCreditRequest: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    walletTransaction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
}

describe("WalletService", () => {
  let service: WalletService;
  let prisma: ReturnType<typeof makeMockPrisma>;

  beforeEach(async () => {
    prisma = makeMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: prisma },
        ConfigService,
      ],
    }).compile();
    service = module.get(WalletService);
  });

  // ────────────────────────────────────────────
  //  getWallet
  // ────────────────────────────────────────────

  describe("getWallet", () => {
    it("lazily creates wallet and returns balance", async () => {
      prisma.wallet.upsert.mockResolvedValue({
        id: "w-1",
        userId: "u-1",
        balancePaise: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await service.getWallet("u-1");
      expect(result.balancePaise).toBe(0);
      expect(result.currency).toBe("INR");
      expect(prisma.wallet.upsert).toHaveBeenCalledWith({
        where: { userId: "u-1" },
        create: { userId: "u-1" },
        update: {},
      });
    });
  });

  // ────────────────────────────────────────────
  //  createCreditRequest (auto-credit OFF)
  // ────────────────────────────────────────────

  describe("createCreditRequest (auto-credit OFF)", () => {
    const wallet = { id: "w-1", userId: "u-1", balancePaise: 0 };
    let tx: ReturnType<typeof makeMockPrisma>;

    beforeEach(() => {
      tx = makeMockPrisma();
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));
      tx.wallet.upsert.mockResolvedValue({ ...wallet, autoCreditEnabled: false });
      // `requiresApproval` reads the wallet row's flag.
      tx.wallet.findUnique.mockResolvedValue({
        ...wallet,
        autoCreditEnabled: false,
      });
      tx.$queryRaw.mockResolvedValue([]);
    });

    it("first request is PENDING and does not change balance", async () => {
      tx.walletCreditRequest.findUnique.mockResolvedValue(null);
      tx.walletTransaction.findFirst.mockResolvedValue(null);
      tx.walletCreditRequest.findFirst.mockResolvedValue(null);
      tx.walletCreditRequest.create.mockResolvedValue({
        id: "req-1",
        walletId: "w-1",
        amountPaise: 5000,
        status: WalletCreditRequestStatus.PENDING,
        autoApproved: false,
        createdAt: new Date(),
      });

      const result = await service.createCreditRequest("u-1", { amount: 5000 }, "key-1");
      expect(result.status).toBe(WalletCreditRequestStatus.PENDING);
      expect(result.message).toContain("admin approval");
      // No balance change call
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it("second request while PENDING is refused", async () => {
      tx.walletCreditRequest.findUnique.mockResolvedValue(null);
      tx.walletTransaction.findFirst.mockResolvedValue(null);
      tx.walletCreditRequest.findFirst.mockResolvedValue({
        id: "req-existing",
        status: WalletCreditRequestStatus.PENDING,
      });

      await expect(
        service.createCreditRequest("u-1", { amount: 3000 }, "key-2"),
      ).rejects.toThrow(ConflictException);
    });

    it("idempotent: same key+hash replays the original", async () => {
      tx.walletCreditRequest.findUnique.mockResolvedValue({
        id: "req-1",
        amountPaise: 5000,
        status: WalletCreditRequestStatus.PENDING,
        autoApproved: false,
        requestHash: "amount:5000",
        createdAt: new Date(),
      });

      const result = await service.createCreditRequest("u-1", { amount: 5000 }, "key-1");
      expect(result.replayed).toBe(true);
      expect(result.id).toBe("req-1");
    });

    it("idempotent: same key but different hash is refused", async () => {
      tx.walletCreditRequest.findUnique.mockResolvedValue({
        id: "req-1",
        amountPaise: 5000,
        requestHash: "amount:5000",
      });

      await expect(
        service.createCreditRequest("u-1", { amount: 9999 }, "key-1"),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects amount below minimum", async () => {
      await expect(
        service.createCreditRequest("u-1", { amount: 10 }, "key-low"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects amount above maximum", async () => {
      await expect(
        service.createCreditRequest("u-1", { amount: 99999999 }, "key-high"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ────────────────────────────────────────────
  //  createCreditRequest (auto-credit ON, returning customer)
  // ────────────────────────────────────────────

  describe("createCreditRequest (auto-credit ON, returning customer)", () => {
    let serviceAutoOn: WalletService;
    let prismaAutoOn: ReturnType<typeof makeMockPrisma>;
    let tx: ReturnType<typeof makeMockPrisma>;

    beforeEach(async () => {
      prismaAutoOn = makeMockPrisma();
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WalletService,
          { provide: PrismaService, useValue: prismaAutoOn },
          {
            provide: ConfigService,
            useValue: {
              get: (key: string) => {
                const map: Record<string, string> = {
                  // No global auto-credit flag; the wallet row decides.
                  WALLET_CREDIT_MIN_PAISE: "100",
                  WALLET_CREDIT_MAX_PAISE: "1000000",
                };
                return map[key];
              },
            },
          },
        ],
      }).compile();
      serviceAutoOn = module.get(WalletService);
      tx = makeMockPrisma();
      prismaAutoOn.$transaction.mockImplementation((cb: any) => cb(tx));
      tx.wallet.upsert.mockResolvedValue({
        id: "w-1",
        userId: "u-1",
        balancePaise: 0,
        autoCreditEnabled: true,
      });
      // `requiresApproval` reads the wallet row's flag.
      tx.wallet.findUnique.mockResolvedValue({
        id: "w-1",
        userId: "u-1",
        balancePaise: 0,
        autoCreditEnabled: true,
      });
      tx.$queryRaw.mockResolvedValue([]);
    });

    it("first request still needs approval when the wallet flag is false", async () => {
      // Override to a FRESH wallet (autoCreditEnabled=false). Even inside this
      // 'returning customer' describe block, a wallet that has not yet
      // completed a credit still requires admin approval.
      tx.wallet.findUnique.mockResolvedValue({
        id: "w-1",
        userId: "u-1",
        balancePaise: 0,
        autoCreditEnabled: false,
      });
      tx.walletCreditRequest.findUnique.mockResolvedValue(null);
      tx.walletTransaction.findFirst.mockResolvedValue(null);
      tx.walletCreditRequest.findFirst.mockResolvedValue(null);
      tx.walletCreditRequest.create.mockResolvedValue({
        id: "req-1",
        amountPaise: 5000,
        status: WalletCreditRequestStatus.PENDING,
        autoApproved: false,
        createdAt: new Date(),
      });

      const result = await serviceAutoOn.createCreditRequest("u-1", { amount: 5000 }, "key-1");
      expect(result.status).toBe(WalletCreditRequestStatus.PENDING);
    });

    it("auto-credits after first completed credit (even when balance is 0)", async () => {
      // First call: idempotency check returns null (no existing request)
      // Second call: fetch created request with transaction
      const req = {
        id: "req-2",
        walletId: "w-1",
        amountPaise: 3000,
        status: WalletCreditRequestStatus.COMPLETED,
        autoApproved: true,
        completedAt: new Date(),
        createdAt: new Date(),
      };
      tx.walletCreditRequest.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...req, transaction: { id: "txn-1" } });
      // Has a completed credit in history
      tx.walletTransaction.findFirst.mockResolvedValue({ id: "txn-old" });

      tx.walletCreditRequest.create.mockResolvedValue(req);
      tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ balance_paise: 3000 }]);
      tx.walletTransaction.create.mockResolvedValue({
        id: "txn-1",
        balanceAfterPaise: 3000,
      });

      const result = await serviceAutoOn.createCreditRequest("u-1", { amount: 3000 }, "key-2");
      expect(result.status).toBe(WalletCreditRequestStatus.COMPLETED);
      expect(result.autoApproved).toBe(true);
    });
  });

  // ────────────────────────────────────────────
  //  approveCreditRequest
  // ────────────────────────────────────────────

  describe("approveCreditRequest", () => {
    let tx: ReturnType<typeof makeMockPrisma>;

    beforeEach(() => {
      tx = makeMockPrisma();
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));
    });

    it("credits once and writes one COMPLETED ledger row", async () => {
      tx.walletCreditRequest.updateMany.mockResolvedValue({ count: 1 });
      tx.walletCreditRequest.findUnique.mockResolvedValue({
        id: "req-1",
        walletId: "w-1",
        amountPaise: 5000,
      });
      tx.$queryRaw.mockResolvedValue([{ balance_paise: 5000 }]);
      tx.walletTransaction.create.mockResolvedValue({
        id: "txn-1",
        balanceAfterPaise: 5000,
      });

      const result = await service.approveCreditRequest("req-1", "admin-1");
      expect(result.success).toBe(true);
      expect(result.request.status).toBe(WalletCreditRequestStatus.COMPLETED);
      expect(tx.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("returns 404 for nonexistent request", async () => {
      tx.walletCreditRequest.updateMany.mockResolvedValue({ count: 0 });
      tx.walletCreditRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.approveCreditRequest("nonexistent", "admin-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns 409 for already-processed request", async () => {
      tx.walletCreditRequest.updateMany.mockResolvedValue({ count: 0 });
      tx.walletCreditRequest.findUnique.mockResolvedValue({
        id: "req-1",
        status: WalletCreditRequestStatus.COMPLETED,
      });

      await expect(
        service.approveCreditRequest("req-1", "admin-1"),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ────────────────────────────────────────────
  //  rejectCreditRequest
  // ────────────────────────────────────────────

  describe("rejectCreditRequest", () => {
    let tx: ReturnType<typeof makeMockPrisma>;

    beforeEach(() => {
      tx = makeMockPrisma();
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));
    });

    it("rejects with note, sets REFUND_PENDING, no balance change", async () => {
      tx.walletCreditRequest.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.rejectCreditRequest("req-1", "admin-1", {
        note: "Payment not verified",
      });
      expect(result.success).toBe(true);
      expect(result.request.status).toBe(WalletCreditRequestStatus.REJECTED);
      expect(result.request.refundStatus).toBe(WalletRefundStatus.REFUND_PENDING);
      // No balance change
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it("returns 409 for already-processed request", async () => {
      tx.walletCreditRequest.updateMany.mockResolvedValue({ count: 0 });
      tx.walletCreditRequest.findUnique.mockResolvedValue({
        id: "req-1",
        status: WalletCreditRequestStatus.COMPLETED,
      });

      await expect(
        service.rejectCreditRequest("req-1", "admin-1", { note: "test" }),
      ).rejects.toThrow(ConflictException);
    });

    it("returns 404 for nonexistent request", async () => {
      tx.walletCreditRequest.updateMany.mockResolvedValue({ count: 0 });
      tx.walletCreditRequest.findUnique.mockResolvedValue(null);

      await expect(
        service.rejectCreditRequest("nonexistent", "admin-1", { note: "test" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ────────────────────────────────────────────
  //  debitWallet
  // ────────────────────────────────────────────

  describe("debitWallet", () => {
    let tx: ReturnType<typeof makeMockPrisma>;

    beforeEach(() => {
      tx = makeMockPrisma();
      prisma.$transaction.mockImplementation((cb: any) => cb(tx));
    });

    it("debits successfully", async () => {
      tx.wallet.findUnique.mockResolvedValue({ id: "w-1", userId: "u-1", balancePaise: 10000 });
      tx.$queryRaw.mockResolvedValue([{ balance_paise: 5000 }]);
      tx.walletTransaction.create.mockResolvedValue({ id: "txn-1", balanceAfterPaise: 5000 });

      const result = await service.debitWallet(
        "u-1",
        5000,
        WalletTransactionReferenceType.ORDER,
        "order-1",
      );
      expect(result.success).toBe(true);
      expect(result.balanceAfterPaise).toBe(5000);
    });

    it("throws INSUFFICIENT_WALLET_BALANCE when balance is too low", async () => {
      tx.wallet.findUnique.mockResolvedValue({ id: "w-1", userId: "u-1", balancePaise: 100 });
      tx.$queryRaw.mockResolvedValue([]); // no rows returned

      await expect(
        service.debitWallet("u-1", 5000, WalletTransactionReferenceType.ORDER, "order-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-positive amounts", async () => {
      await expect(
        service.debitWallet("u-1", 0, WalletTransactionReferenceType.ORDER, "order-1"),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.debitWallet("u-1", -100, WalletTransactionReferenceType.ORDER, "order-1"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when wallet not found", async () => {
      tx.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.debitWallet("u-1", 1000, WalletTransactionReferenceType.ORDER, "order-1"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ────────────────────────────────────────────
  //  getTransactions
  // ────────────────────────────────────────────

  describe("getTransactions", () => {
    it("returns paginated transactions", async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: "w-1" });
      prisma.walletTransaction.findMany.mockResolvedValue([
        {
          id: "txn-1",
          type: WalletTransactionType.CREDIT,
          amountPaise: 5000,
          balanceAfterPaise: 5000,
          referenceType: WalletTransactionReferenceType.CREDIT_REQUEST,
          referenceId: "req-1",
          description: null,
          createdAt: new Date(),
        },
      ]);
      prisma.walletTransaction.count.mockResolvedValue(1);

      const result = await service.getTransactions("u-1", {});
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });
  });

  // ────────────────────────────────────────────
  //  getCreditRequests (customer)
  // ────────────────────────────────────────────

  describe("getCreditRequests (customer)", () => {
    it("returns requests without internal fields", async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: "w-1" });
      prisma.walletCreditRequest.findMany.mockResolvedValue([
        {
          id: "req-1",
          amountPaise: 5000,
          status: WalletCreditRequestStatus.REJECTED,
          autoApproved: false,
          adminNote: "Not verified",
          refundStatus: WalletRefundStatus.REFUND_PENDING,
          reviewedAt: new Date(),
          completedAt: null,
          createdAt: new Date(),
        },
      ]);
      prisma.walletCreditRequest.count.mockResolvedValue(1);

      const result = await service.getCreditRequests("u-1", {});
      expect(result.data[0].adminNote).toBe("Not verified");
      expect(result.data[0].refundStatus).toBe(WalletRefundStatus.REFUND_PENDING);
    });

    it("hides adminNote and refundStatus on non-rejected requests", async () => {
      prisma.wallet.upsert.mockResolvedValue({ id: "w-1" });
      prisma.walletCreditRequest.findMany.mockResolvedValue([
        {
          id: "req-1",
          amountPaise: 5000,
          status: WalletCreditRequestStatus.PENDING,
          autoApproved: false,
          adminNote: null,
          refundStatus: WalletRefundStatus.NOT_REQUIRED,
          reviewedAt: null,
          completedAt: null,
          createdAt: new Date(),
        },
      ]);
      prisma.walletCreditRequest.count.mockResolvedValue(1);

      const result = await service.getCreditRequests("u-1", {});
      expect(result.data[0]).not.toHaveProperty("adminNote");
      expect(result.data[0]).not.toHaveProperty("refundStatus");
    });
  });

  // ────────────────────────────────────────────
  //  Admin — getAdminCreditRequest
  // ────────────────────────────────────────────

  describe("getAdminCreditRequest", () => {
    it("returns 404 for nonexistent request", async () => {
      prisma.walletCreditRequest.findUnique.mockResolvedValue(null);
      await expect(service.getAdminCreditRequest("bad")).rejects.toThrow(NotFoundException);
    });
  });

  // ────────────────────────────────────────────
  //  Admin — getAdminCustomerWallet
  // ────────────────────────────────────────────

  describe("getAdminCustomerWallet", () => {
    it("returns 404 when wallet not found", async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);
      await expect(service.getAdminCustomerWallet("bad")).rejects.toThrow(NotFoundException);
    });

    it("returns wallet with summary", async () => {
      prisma.wallet.findUnique.mockResolvedValue({
        id: "w-1",
        userId: "u-1",
        balancePaise: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
        user: {
          id: "u-1",
          mobile: "9999999999",
          email: "test@example.com",
          customerProfile: { firstName: "Test", lastName: "User" },
        },
        transactions: [],
      });
      prisma.walletTransaction.aggregate.mockResolvedValueOnce({
        _sum: { amountPaise: 10000 },
        _count: 2,
      });
      prisma.walletTransaction.aggregate.mockResolvedValueOnce({
        _sum: { amountPaise: 5000 },
        _count: 1,
      });

      const result = await service.getAdminCustomerWallet("u-1");
      expect(result.balancePaise).toBe(5000);
      expect(result.summary.totalCreditsPaise).toBe(10000);
      expect(result.summary.totalDebitsPaise).toBe(5000);
      expect(result.customer.name).toBe("Test User");
    });
  });

  // ────────────────────────────────────────────
  //  Money stays integer paise
  // ────────────────────────────────────────────

  describe("money invariants", () => {
    it("CreateCreditRequestDto amount must be integer", async () => {
      await expect(
        service.createCreditRequest("u-1", { amount: 50.5 } as any, "key-float"),
      ).rejects.toThrow(BadRequestException);
    });

    it("debitWallet rejects floating-point amounts", async () => {
      await expect(
        service.debitWallet("u-1", 50.5, WalletTransactionReferenceType.ORDER, "order-1"),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
