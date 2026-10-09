// @nestjs/config and @nestjs/jwt ship ESM-only; mock them so the CommonJS test
// runner can load the JwtAuthGuard. Their behaviour is supplied per-test below.
jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));
jest.mock("@nestjs/jwt", () => ({
  JwtService: jest.fn().mockImplementation(() => ({ verifyAsync: jest.fn() })),
}));

import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import request from "supertest";
import { PlansController } from "./plans.controller";
import { AdminPlansController } from "./admin-plans.controller";
import { PlansService } from "./plans.service";
import { PrismaService } from "../../prisma/prisma.service";
import { WalletService } from "../wallet/wallet.service";
import {
  DeliveryFrequency,
  PlanQuoteStatus,
  PlanSelectionStatus,
  PlanType,
  QuantityMode,
} from "./plans.constants";

/**
 * HTTP-level integration: admin config edits -> customer plan APIs.
 *
 * Runs the REAL JwtAuthGuard (role checks), the REAL global ValidationPipe
 * (as configured in main.ts), both REAL controllers and the REAL PlansService
 * over an in-memory Prisma fake. The only stubs are token verification and
 * storage, so this proves the single-source-of-truth wiring end to end.
 */
describe("Admin plan configuration -> customer plans (HTTP integration)", () => {
  let app: INestApplication;

  // ── In-memory database ────────────────────────────────────────────

  type Row = Record<string, any>;
  const db = {
    planConfigs: [] as Row[],
    quotes: [] as Row[],
    selections: [] as Row[],
    deliveries: [] as Row[],
    orders: [] as Row[],
  };

  const configDefaults = {
    quantityMin: 1,
    quantityMax: 5,
    maxUsages: 7,
    trialDurationDays: 7,
    isActive: true,
    dailyEnabled: true,
    alternateDaysEnabled: true,
    fixedQuantityEnabled: true,
    alternatingQuantityEnabled: true,
  };

  function seedConfigs() {
    const now = new Date();
    db.planConfigs = [
      { planType: PlanType.BUY_ONCE, actualPricePerLitre: 12000, sellingPricePerLitre: 10000 },
      { planType: PlanType.SEVEN_DAY_TRIAL, actualPricePerLitre: 11000, sellingPricePerLitre: 9500, maxUsages: 1 },
      { planType: PlanType.MONTHLY, actualPricePerLitre: 10000, sellingPricePerLitre: 9000 },
    ].map((c) => ({ id: randomUUID(), ...configDefaults, ...c, createdAt: now, updatedAt: now }));
  }

  const matchStatus = (row: Row, status: any) =>
    status === undefined ||
    (typeof status === "object" ? row.status !== status.not : row.status === status);

  const prisma: any = {
    session: {
      findUnique: async ({ where }: any) => sessions[where.id] ?? null,
    },
    planConfig: {
      findFirst: async ({ where }: any) =>
        db.planConfigs.find(
          (c) =>
            c.planType === where.planType &&
            (where.isActive === undefined || c.isActive === where.isActive),
        ) ?? null,
      findUnique: async ({ where }: any) =>
        db.planConfigs.find((c) => c.planType === where.planType) ?? null,
      findMany: async () => [...db.planConfigs],
      update: async ({ where, data }: any) => {
        const row = db.planConfigs.find((c) => c.planType === where.planType)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      create: async ({ data }: any) => {
        const now = new Date();
        const row = { id: randomUUID(), ...configDefaults, ...data, createdAt: now, updatedAt: now };
        db.planConfigs.push(row);
        return { ...row };
      },
    },
    planQuote: {
      create: async ({ data }: any) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        db.quotes.push(row);
        return row;
      },
      findUnique: async ({ where }: any) =>
        db.quotes.find((q) => q.id === where.id) ?? null,
      update: async ({ where, data }: any) =>
        Object.assign(db.quotes.find((q) => q.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const hits = db.quotes.filter(
          (q) => q.id === where.id && q.status === where.status,
        );
        hits.forEach((q) => Object.assign(q, data));
        return { count: hits.length };
      },
    },
    planSelection: {
      count: async ({ where }: any) =>
        db.selections.filter(
          (s) =>
            s.userId === where.userId &&
            s.planType === where.planType &&
            matchStatus(s, where.status),
        ).length,
      create: async ({ data }: any) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        db.selections.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = db.selections.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
      delete: async ({ where }: any) => {
        const idx = db.selections.findIndex((s) => s.id === where.id);
        if (idx >= 0) db.selections.splice(idx, 1);
      },
    },
    wallet: {
      findUnique: async () => ({ balancePaise: 999_999_999 }),
    },
    cashCollection: {
      create: async ({ data }: any) => ({ id: randomUUID(), ...data }),
    },
    planDelivery: {
      createMany: async ({ data }: any) => {
        db.deliveries.push(
          ...data.map((d: any) => ({ id: randomUUID(), ...d })),
        );
        return { count: data.length };
      },
      findMany: async ({ where }: any) => {
        const list = db.deliveries.filter(
          (d) => d.selectionId === where.selectionId,
        );
        return list.map((d) => ({ ...d }));
      },
    },
    customerAddress: {
      findFirst: async () => null,
    },
    invoice: {
      count: async () => db.orders.length,
    },
    order: {
      findUnique: async ({ where }: any) =>
        db.orders.find((o) => o.planDeliveryId === where.planDeliveryId) ??
        null,
      count: async () => db.orders.length,
      create: async ({ data }: any) => {
        const { items, invoice, ...orderData } = data;
        const row = { id: randomUUID(), ...orderData };
        db.orders.push(row);
        return { ...row };
      },
    },
    $executeRaw: async () => 1,
    $transaction: async (fn: any) => fn(prisma),
  };

  // ── Auth fixtures ─────────────────────────────────────────────────

  const ADMIN_ID = "admin-1";
  const sessions: Record<string, Row> = {
    "sess-admin": { id: "sess-admin", adminId: ADMIN_ID, userId: null },
    "sess-c1": { id: "sess-c1", userId: "cust-1", adminId: null },
    "sess-c2": { id: "sess-c2", userId: "cust-2", adminId: null },
  };
  for (const s of Object.values(sessions)) {
    Object.assign(s, { revokedAt: null, expiresAt: new Date(Date.now() + 3_600_000) });
  }

  const tokens: Record<string, Row> = {
    "admin-token": { sub: ADMIN_ID, role: "ADMIN", sessionId: "sess-admin", type: "access" },
    "cust1-token": { sub: "cust-1", role: "CUSTOMER", sessionId: "sess-c1", type: "access" },
    "cust2-token": { sub: "cust-2", role: "CUSTOMER", sessionId: "sess-c2", type: "access" },
  };
  const ADMIN = { Authorization: "Bearer admin-token" };
  const CUST1 = { Authorization: "Bearer cust1-token" };
  const CUST2 = { Authorization: "Bearer cust2-token" };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PlansController, AdminPlansController],
      providers: [
        PlansService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: { debitWalletWithin: jest.fn() } },
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              if (!tokens[token]) throw new Error("invalid signature");
              return tokens[token];
            },
          },
        },
        { provide: ConfigService, useValue: { get: () => "test-secret" } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Same global pipe as main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => {
    seedConfigs();
    db.quotes = [];
    db.selections = [];
    db.deliveries = [];
    db.orders = [];
  });

  const http = () => request(app.getHttpServer());
  const patch = (planType: string, body: object | string) =>
    http().patch(`/api/v1/admin/plans/${planType}`).set(ADMIN).send(body);
  const cfg = (planType: PlanType) =>
    db.planConfigs.find((c) => c.planType === planType)!;

  /** Quote + confirm in one go, through the real customer HTTP API. */
  async function buyAndConfirm(auth: Record<string, string>, path: string, body: object) {
    const quote = await http().post(path).set(auth).send(body).expect(200);
    return http()
      .post("/api/v1/customer/plans/confirm")
      .set(auth)
      .send({ quoteId: quote.body.quoteId, paymentMethod: "WALLET" })
      .expect(200);
  }

  // ── Authentication / RBAC ─────────────────────────────────────────

  describe("authentication and RBAC", () => {
    const routes: [string, string][] = [
      ["get", "/api/v1/admin/plans"],
      ["get", "/api/v1/admin/plans/BUY_ONCE"],
      ["patch", "/api/v1/admin/plans/BUY_ONCE"],
      ["get", "/admin/plans"],
      ["get", "/admin/plans/MONTHLY"],
      ["patch", "/admin/plans/MONTHLY"],
    ];

    it.each(routes)("%s %s without a token -> 401", async (method, url) => {
      await (http() as any)[method](url).send({ isActive: true }).expect(401);
    });

    it.each(routes)("%s %s with an invalid token -> 401", async (method, url) => {
      await (http() as any)[method](url)
        .set({ Authorization: "Bearer forged" })
        .send({ isActive: true })
        .expect(401);
    });

    it.each(routes)("%s %s with a CUSTOMER token -> 403", async (method, url) => {
      await (http() as any)[method](url).set(CUST1).send({ isActive: false }).expect(403);
      // A rejected request never mutates config.
      expect(db.planConfigs.every((c) => c.isActive)).toBe(true);
    });

    it.each(routes)("%s %s with an ADMIN token -> 200", async (method, url) => {
      await (http() as any)[method](url).set(ADMIN).send({ isActive: true }).expect(200);
    });

    it("an ADMIN token cannot use customer plan routes (403)", async () => {
      await http().get("/api/v1/customer/plans").set(ADMIN).expect(403);
    });

    it("rejects adminId in the body (400) and leaves config unchanged", async () => {
      const res = await patch(PlanType.BUY_ONCE, {
        adminId: "someone-else",
        sellingPricePerLitre: 1,
      }).expect(400);
      expect(JSON.stringify(res.body)).toContain("adminId");
      expect(cfg(PlanType.BUY_ONCE).sellingPricePerLitre).toBe(10000);
    });

    it("ignores adminId in the query string; identity comes from the JWT only", async () => {
      await http()
        .get("/api/v1/admin/plans?adminId=evil")
        .set(ADMIN)
        .expect(200);
    });
  });

  // ── Admin reads ───────────────────────────────────────────────────

  describe("GET /admin/plans", () => {
    it("returns all three plans with the dashboard fields and nothing sensitive", async () => {
      const { body } = await http().get("/api/v1/admin/plans").set(ADMIN).expect(200);
      expect(body.unconfigured).toEqual([]);
      expect(body.plans.map((p: any) => p.type)).toEqual([
        "BUY_ONCE",
        "SEVEN_DAY_TRIAL",
        "MONTHLY",
      ]);
      const common = [
        "type", "isActive", "actualPricePerLitre", "sellingPricePerLitre",
        "quantityMin", "quantityMax", "createdAt", "updatedAt",
      ];
      expect(Object.keys(body.plans[0]).sort()).toEqual([...common, "maxUsages"].sort());
      expect(Object.keys(body.plans[1]).sort()).toEqual(
        [...common, "maxUsages", "trialDurationDays"].sort(),
      );
      expect(Object.keys(body.plans[2]).sort()).toEqual(
        [
          ...common, "dailyEnabled", "alternateDaysEnabled", "fixedQuantityEnabled",
          "alternatingQuantityEnabled", "frequencies", "quantityModes",
        ].sort(),
      );
      expect(body.plans[1].maxUsages).toBe(1);
      expect(body.plans[2].frequencies).toEqual(["DAILY", "ALTERNATE_DAYS"]);
      expect(JSON.stringify(body)).not.toMatch(/password|token|session|userId/i);
    });

    it("GET one plan", async () => {
      const { body } = await http().get("/admin/plans/SEVEN_DAY_TRIAL").set(ADMIN).expect(200);
      expect(body).toMatchObject({ type: "SEVEN_DAY_TRIAL", trialDurationDays: 7 });
    });

    it.each(["TRIAL", "buy_once", "WEEKLY", "1"])("GET invalid planType %p -> 400", async (t) => {
      await http().get(`/api/v1/admin/plans/${t}`).set(ADMIN).expect(400);
    });

    it("GET a missing config -> 404, without creating it", async () => {
      db.planConfigs = db.planConfigs.filter((c) => c.planType !== PlanType.MONTHLY);
      await http().get("/api/v1/admin/plans/MONTHLY").set(ADMIN).expect(404);
      const { body } = await http().get("/api/v1/admin/plans").set(ADMIN).expect(200);
      expect(body.unconfigured).toEqual(["MONTHLY"]);
      expect(db.planConfigs).toHaveLength(2);
    });
  });

  // ── Admin updates ─────────────────────────────────────────────────

  describe("PATCH /admin/plans/:planType", () => {
    it("updates Buy Once", async () => {
      const { body } = await patch("BUY_ONCE", {
        actualPricePerLitre: 9500,
        sellingPricePerLitre: 8500,
        quantityMax: 4,
        maxUsages: 5,
        isActive: true,
      }).expect(200);
      expect(body).toMatchObject({
        type: "BUY_ONCE", actualPricePerLitre: 9500, sellingPricePerLitre: 8500,
        quantityMax: 4, maxUsages: 5, isActive: true,
      });
      expect(cfg(PlanType.BUY_ONCE)).toMatchObject({ sellingPricePerLitre: 8500, maxUsages: 5 });
    });

    it("updates Trial", async () => {
      const { body } = await patch("SEVEN_DAY_TRIAL", {
        sellingPricePerLitre: 9000,
        quantityMax: 3,
      }).expect(200);
      expect(body).toMatchObject({ sellingPricePerLitre: 9000, quantityMax: 3, trialDurationDays: 7, maxUsages: 1 });
    });

    it("updates Monthly", async () => {
      const { body } = await patch("MONTHLY", {
        actualPricePerLitre: 10500,
        sellingPricePerLitre: 9200,
        quantityMin: 2,
        quantityMax: 4,
        dailyEnabled: true,
        alternateDaysEnabled: false,
        fixedQuantityEnabled: true,
        alternatingQuantityEnabled: true,
        isActive: true,
      }).expect(200);
      expect(body.frequencies).toEqual(["DAILY"]);
      expect(body.quantityModes).toEqual(["FIXED", "ALTERNATING"]);
      expect(cfg(PlanType.MONTHLY).alternateDaysEnabled).toBe(false);
    });

    it("disables and re-enables a plan", async () => {
      await patch("SEVEN_DAY_TRIAL", { isActive: false }).expect(200);
      expect(cfg(PlanType.SEVEN_DAY_TRIAL).isActive).toBe(false);
      await patch("SEVEN_DAY_TRIAL", { isActive: true }).expect(200);
      expect(cfg(PlanType.SEVEN_DAY_TRIAL).isActive).toBe(true);
    });

    it("works through the legacy /admin/plans prefix too", async () => {
      await http().patch("/admin/plans/BUY_ONCE").set(ADMIN).send({ maxUsages: 2 }).expect(200);
      expect(cfg(PlanType.BUY_ONCE).maxUsages).toBe(2);
    });

    it("PATCH invalid planType -> 400 and creates nothing", async () => {
      await patch("PREMIUM", { actualPricePerLitre: 1, sellingPricePerLitre: 1 }).expect(400);
      expect(db.planConfigs).toHaveLength(3);
    });

    it.each([
      ["string price", "BUY_ONCE", { sellingPricePerLitre: "8500" }],
      ["float (rupee) price", "BUY_ONCE", { sellingPricePerLitre: 85.5 }],
      ["negative price", "MONTHLY", { actualPricePerLitre: -100 }],
      ["quantityMax 6", "BUY_ONCE", { quantityMax: 6 }],
      ["quantityMin 0", "MONTHLY", { quantityMin: 0 }],
      ["min > max", "MONTHLY", { quantityMin: 4, quantityMax: 2 }],
      ["stored max < new min", "BUY_ONCE", { quantityMin: 5, quantityMax: 4 }],
      ["selling > actual", "BUY_ONCE", { sellingPricePerLitre: 12001 }],
      ["maxUsages 0", "BUY_ONCE", { maxUsages: 0 }],
      ["maxUsages float", "BUY_ONCE", { maxUsages: 2.5 }],
      ["Trial maxUsages", "SEVEN_DAY_TRIAL", { maxUsages: 2 }],
      ["Trial trialDurationDays", "SEVEN_DAY_TRIAL", { trialDurationDays: 5 }],
      ["string boolean", "MONTHLY", { dailyEnabled: "true" }],
      ["no frequency left", "MONTHLY", { dailyEnabled: false, alternateDaysEnabled: false }],
      ["no quantity mode left", "MONTHLY", { fixedQuantityEnabled: false, alternatingQuantityEnabled: false }],
      ["empty body", "BUY_ONCE", {}],
    ])("rejects %s with 400 and writes nothing", async (_label, planType, body) => {
      const before = JSON.stringify(db.planConfigs);
      await patch(planType, body).expect(400);
      expect(JSON.stringify(db.planConfigs)).toBe(before);
    });

    it("missing config: 404 unless both prices are supplied, then initialised", async () => {
      db.planConfigs = db.planConfigs.filter((c) => c.planType !== PlanType.MONTHLY);
      await patch("MONTHLY", { isActive: true }).expect(404);
      await patch("MONTHLY", { actualPricePerLitre: 10000, sellingPricePerLitre: 9000 }).expect(200);
      await http().get("/api/v1/customer/plans/monthly").set(CUST1).expect(200)
        .expect(({ body }) => expect(body.available).toBe(true));
    });
  });

  // ── Customer side uses the admin config ───────────────────────────

  describe("customer plans use the admin configuration", () => {
    it("Buy Once quote uses the admin-updated selling price", async () => {
      await patch("BUY_ONCE", { sellingPricePerLitre: 8500 }).expect(200);
      const { body } = await http()
        .post("/api/v1/customer/plans/buy-once/quote")
        .set(CUST1)
        .send({ quantityLitres: 2 })
        .expect(200);
      expect(body).toMatchObject({
        sellingPricePerLitre: 8500,
        actualPricePerLitre: 12000,
        totalSellingAmount: 17000,
        totalActualAmount: 24000,
        discountAmount: 7000,
      });
    });

    it("Buy Once: disable -> quote rejected, re-enable -> quote works", async () => {
      const quote = () =>
        http().post("/api/v1/customer/plans/buy-once/quote").set(CUST1).send({ quantityLitres: 1 });

      await patch("BUY_ONCE", { isActive: false }).expect(200);
      await quote().expect(403);
      const elig = await http().get("/api/v1/customer/plans/buy-once/eligibility").set(CUST1).expect(200);
      expect(elig.body.eligible).toBe(false);

      await patch("BUY_ONCE", { isActive: true }).expect(200);
      await quote().expect(200);
    });

    it("Trial: disabled -> quote rejected", async () => {
      await patch("SEVEN_DAY_TRIAL", { isActive: false }).expect(200);
      await http().post("/api/v1/customer/plans/trial/quote").set(CUST1)
        .send({ quantityLitres: 1 }).expect(403);
    });

    it("Monthly: disabled -> overview unavailable, info unavailable, quote rejected", async () => {
      await patch("MONTHLY", { isActive: false }).expect(200);
      const overview = await http().get("/api/v1/customer/plans").set(CUST1).expect(200);
      expect(overview.body.plans.find((p: any) => p.type === "MONTHLY").available).toBe(false);
      const info = await http().get("/api/v1/customer/plans/monthly").set(CUST1).expect(200);
      expect(info.body.available).toBe(false);
      await http().post("/api/v1/customer/plans/monthly/quote").set(CUST1)
        .send({ frequency: "DAILY", quantityMode: "FIXED", quantity: 1 }).expect(400);
    });

    it("Monthly: disabled ALTERNATE_DAYS is hidden and rejected; re-enabling restores it", async () => {
      const altQuote = () =>
        http().post("/api/v1/customer/plans/monthly/quote").set(CUST1)
          .send({ frequency: "ALTERNATE_DAYS", quantityMode: "FIXED", quantity: 2 });

      await patch("MONTHLY", { alternateDaysEnabled: false }).expect(200);
      const info = await http().get("/api/v1/customer/plans/monthly").set(CUST1).expect(200);
      expect(info.body.frequencies).toEqual(["DAILY"]);
      const rejected = await altQuote().expect(400);
      expect(rejected.body.message).toMatch(/ALTERNATE_DAYS is not currently available/);
      await http().post("/api/v1/customer/plans/monthly/quote").set(CUST1)
        .send({ frequency: "DAILY", quantityMode: "FIXED", quantity: 2 }).expect(200);

      await patch("MONTHLY", { alternateDaysEnabled: true }).expect(200);
      await altQuote().expect(200);
    });

    it("Monthly: disabled ALTERNATING quantity mode is hidden and rejected", async () => {
      await patch("MONTHLY", { alternatingQuantityEnabled: false }).expect(200);
      const info = await http().get("/api/v1/customer/plans/monthly").set(CUST1).expect(200);
      expect(info.body.quantityModes).toEqual(["FIXED"]);
      await http().post("/api/v1/customer/plans/monthly/quote").set(CUST1)
        .send({ frequency: "DAILY", quantityMode: "ALTERNATING", quantityA: 1, quantityB: 2 })
        .expect(400);
    });

    it("Monthly info reflects admin prices and quantity limits", async () => {
      await patch("MONTHLY", { sellingPricePerLitre: 8800, quantityMax: 3 }).expect(200);
      const info = await http().get("/api/v1/customer/plans/monthly").set(CUST1).expect(200);
      expect(info.body).toMatchObject({ sellingPricePerLitre: 8800, quantityMax: 3 });
      await http().post("/api/v1/customer/plans/monthly/quote").set(CUST1)
        .send({ frequency: "DAILY", quantityMode: "FIXED", quantity: 4 }).expect(400);
    });

    it("Buy Once: admin-lowered maxUsages is enforced on eligibility", async () => {
      await buyAndConfirm(CUST1, "/api/v1/customer/plans/buy-once/quote", { quantityLitres: 1 });
      await patch("BUY_ONCE", { maxUsages: 1 }).expect(200);
      const { body } = await http().get("/api/v1/customer/plans/buy-once/eligibility").set(CUST1).expect(200);
      expect(body).toMatchObject({ eligible: false, maxUses: 1, blockedReason: "MAX_USES_REACHED" });
    });
  });

  // ── Existing customer behaviour is preserved ──────────────────────

  describe("existing customer eligibility and confirmation are preserved", () => {
    const availability = async (auth: Record<string, string>) => {
      const { body } = await http().get("/api/v1/customer/plans").set(auth).expect(200);
      return Object.fromEntries(body.plans.map((p: any) => [p.type, p.available]));
    };

    it("new customer: all three plans available", async () => {
      expect(await availability(CUST1)).toEqual({
        BUY_ONCE: true, SEVEN_DAY_TRIAL: true, MONTHLY: true,
      });
    });

    it("after Buy Once: Buy Once still available, Trial blocked, Monthly available", async () => {
      await buyAndConfirm(CUST1, "/api/v1/customer/plans/buy-once/quote", { quantityLitres: 2 });
      expect(await availability(CUST1)).toEqual({
        BUY_ONCE: true, SEVEN_DAY_TRIAL: false, MONTHLY: true,
      });
      const { body } = await http().get("/api/v1/customer/plans/buy-once/eligibility").set(CUST1).expect(200);
      expect(body).toMatchObject({ usageCount: 1, remainingUses: 6 });
      await http().post("/api/v1/customer/plans/trial/quote").set(CUST1)
        .send({ quantityLitres: 1 }).expect(403);
    });

    it("after Trial: Buy Once blocked, Trial blocked, Monthly available", async () => {
      await buyAndConfirm(CUST2, "/api/v1/customer/plans/trial/quote", { quantityLitres: 1 });
      expect(await availability(CUST2)).toEqual({
        BUY_ONCE: false, SEVEN_DAY_TRIAL: false, MONTHLY: true,
      });
      // The other customer is unaffected.
      expect(await availability(CUST1)).toEqual({
        BUY_ONCE: true, SEVEN_DAY_TRIAL: true, MONTHLY: true,
      });
    });

    it("Monthly confirmation still creates a selection with materialised deliveries", async () => {
      const res = await buyAndConfirm(CUST1, "/api/v1/customer/plans/monthly/quote", {
        frequency: "DAILY", quantityMode: "FIXED", quantity: 2,
      });
      expect(res.body).toMatchObject({ plan: "MONTHLY", status: PlanSelectionStatus.CONFIRMED });
      expect(db.deliveries.length).toBeGreaterThan(0);
    });

    it("a quote issued before the admin disabled the plan cannot be confirmed", async () => {
      const quote = await http().post("/api/v1/customer/plans/buy-once/quote").set(CUST1)
        .send({ quantityLitres: 1 }).expect(200);
      await patch("BUY_ONCE", { isActive: false }).expect(200);
      await http().post("/api/v1/customer/plans/confirm").set(CUST1)
        .send({ quoteId: quote.body.quoteId, paymentMethod: "WALLET" }).expect(403);
      expect(db.selections).toHaveLength(0);
      expect(db.quotes[0].status).toBe(PlanQuoteStatus.PENDING);
    });

    it("disabling a plan leaves existing selections and deliveries untouched", async () => {
      await buyAndConfirm(CUST1, "/api/v1/customer/plans/monthly/quote", {
        frequency: DeliveryFrequency.ALTERNATE_DAYS, quantityMode: QuantityMode.FIXED, quantity: 1,
      });
      const snapshot = JSON.stringify({ s: db.selections, d: db.deliveries });

      await patch("MONTHLY", { isActive: false, alternateDaysEnabled: false }).expect(200);

      expect(JSON.stringify({ s: db.selections, d: db.deliveries })).toBe(snapshot);
      expect(db.selections[0].status).toBe(PlanSelectionStatus.CONFIRMED);
    });

    it("the price on an already-issued quote is a snapshot (later admin price edits don't change it)", async () => {
      const quote = await http().post("/api/v1/customer/plans/buy-once/quote").set(CUST1)
        .send({ quantityLitres: 1 }).expect(200);
      await patch("BUY_ONCE", { sellingPricePerLitre: 5000 }).expect(200);
      expect(db.quotes.find((q) => q.id === quote.body.quoteId)!.sellingPricePerLitre).toBe(10000);
    });
  });
});
