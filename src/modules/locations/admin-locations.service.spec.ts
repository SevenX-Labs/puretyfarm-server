// @nestjs/config ships ESM-only; mock it so the CommonJS test runner can load
// the service graph (GeoapifyService imports ConfigService).
jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { LocationsService } from "./locations.service";
import { PrismaService } from "../../prisma/prisma.service";
import { GeoapifyService } from "./geoapify/geoapify.service";
import { ValkeyService } from "../../valkey/valkey.service";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const uniqueError = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "x",
  });

describe("LocationsService (admin catalog)", () => {
  let service: LocationsService;

  const mockPrisma = {
    state: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    city: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    area: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    customerAddress: { count: jest.fn() },
  };

  const mockGeoapify = { reverseGeocode: jest.fn() };
  const mockValkey = { eval: jest.fn(), get: jest.fn(), set: jest.fn() };

  const now = new Date();
  const stateRow = {
    id: "state-1",
    name: "Maharashtra",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const cityRow = {
    id: "city-1",
    name: "Thane",
    stateId: "state-1",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const areaRow = {
    id: "area-1",
    name: "Diva",
    cityId: "city-1",
    pincode: "400612",
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: no dependents, so deletes are permitted unless overridden.
    mockPrisma.state.count.mockResolvedValue(0);
    mockPrisma.city.count.mockResolvedValue(0);
    mockPrisma.area.count.mockResolvedValue(0);
    mockPrisma.customerAddress.count.mockResolvedValue(0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GeoapifyService, useValue: mockGeoapify },
        { provide: ValkeyService, useValue: mockValkey },
      ],
    }).compile();
    service = module.get<LocationsService>(LocationsService);
  });

  // ===== STATES =============================================================

  describe("states", () => {
    it("creates a state", async () => {
      mockPrisma.state.create.mockResolvedValue(stateRow);
      const result = await service.createState({ name: "Maharashtra" });
      expect(mockPrisma.state.create).toHaveBeenCalledWith({
        data: { name: "Maharashtra" },
        select: expect.any(Object),
      });
      expect(result).toEqual(stateRow);
    });

    it("rejects a duplicate state (P2002 -> 409)", async () => {
      mockPrisma.state.create.mockRejectedValue(uniqueError());
      await expect(service.createState({ name: "Maharashtra" })).rejects.toThrow(
        ConflictException,
      );
    });

    it("lists states including inactive ones (no isActive filter)", async () => {
      mockPrisma.state.findMany.mockResolvedValue([
        stateRow,
        { ...stateRow, id: "state-2", name: "Goa", isActive: false },
      ]);
      const result = await service.getAdminStates();
      expect(mockPrisma.state.findMany).toHaveBeenCalledWith({
        orderBy: { name: "asc" },
        select: expect.any(Object),
      });
      expect(result).toHaveLength(2);
      const call = mockPrisma.state.findMany.mock.calls[0][0];
      expect(call.where).toBeUndefined();
    });

    it("updates a state name", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.state.update.mockResolvedValue({ ...stateRow, name: "MH" });
      const result = await service.updateState("state-1", { name: "MH" });
      expect(mockPrisma.state.update).toHaveBeenCalledWith({
        where: { id: "state-1" },
        data: { name: "MH" },
        select: expect.any(Object),
      });
      expect(result.name).toBe("MH");
    });

    it("disables a state", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.state.update.mockResolvedValue({ ...stateRow, isActive: false });
      const result = await service.updateState("state-1", { isActive: false });
      expect(mockPrisma.state.update).toHaveBeenCalledWith({
        where: { id: "state-1" },
        data: { isActive: false },
        select: expect.any(Object),
      });
      expect(result.isActive).toBe(false);
    });

    it("enables a state", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.state.update.mockResolvedValue({ ...stateRow, isActive: true });
      const result = await service.updateState("state-1", { isActive: true });
      expect(result.isActive).toBe(true);
    });

    it("updating a missing state 404s", async () => {
      mockPrisma.state.findUnique.mockResolvedValue(null);
      await expect(
        service.updateState("missing", { name: "X" }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.state.update).not.toHaveBeenCalled();
    });

    it("deletes a state with no dependents", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.state.delete.mockResolvedValue(stateRow);
      const result = await service.deleteState("state-1");
      expect(result).toEqual({ id: "state-1", deleted: true });
      expect(mockPrisma.state.delete).toHaveBeenCalledWith({
        where: { id: "state-1" },
      });
    });

    it("refuses to delete a state that has cities (409, no delete)", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.city.count.mockResolvedValue(2);
      await expect(service.deleteState("state-1")).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.state.delete).not.toHaveBeenCalled();
    });

    it("refuses to delete a state referenced by customer addresses", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.city.count.mockResolvedValue(0);
      mockPrisma.customerAddress.count.mockResolvedValue(1);
      await expect(service.deleteState("state-1")).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.state.delete).not.toHaveBeenCalled();
    });

    it("deleting a missing state 404s", async () => {
      mockPrisma.state.findUnique.mockResolvedValue(null);
      await expect(service.deleteState("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ===== CITIES =============================================================

  describe("cities", () => {
    it("creates a city under a valid active state", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({
        id: "state-1",
        isActive: true,
      });
      mockPrisma.city.create.mockResolvedValue(cityRow);
      const result = await service.createCity({
        stateId: "state-1",
        name: "Thane",
      });
      expect(result).toEqual(cityRow);
    });

    it("rejects a city under a missing state (404)", async () => {
      mockPrisma.state.findUnique.mockResolvedValue(null);
      await expect(
        service.createCity({ stateId: "missing", name: "Thane" }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.city.create).not.toHaveBeenCalled();
    });

    it("rejects a city under an inactive state (409)", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({
        id: "state-1",
        isActive: false,
      });
      await expect(
        service.createCity({ stateId: "state-1", name: "Thane" }),
      ).rejects.toThrow(ConflictException);
      expect(mockPrisma.city.create).not.toHaveBeenCalled();
    });

    it("rejects a duplicate city (P2002 -> 409)", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({
        id: "state-1",
        isActive: true,
      });
      mockPrisma.city.create.mockRejectedValue(uniqueError());
      await expect(
        service.createCity({ stateId: "state-1", name: "Thane" }),
      ).rejects.toThrow(ConflictException);
    });

    it("lists cities including inactive ones for a state", async () => {
      mockPrisma.state.findUnique.mockResolvedValue({ id: "state-1" });
      mockPrisma.city.findMany.mockResolvedValue([
        cityRow,
        { ...cityRow, id: "city-2", isActive: false },
      ]);
      const result = await service.getAdminCities("state-1");
      expect(mockPrisma.city.findMany).toHaveBeenCalledWith({
        where: { stateId: "state-1" },
        orderBy: { name: "asc" },
        select: expect.any(Object),
      });
      expect(result).toHaveLength(2);
    });

    it("listing cities for a missing state 404s", async () => {
      mockPrisma.state.findUnique.mockResolvedValue(null);
      await expect(service.getAdminCities("missing")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("updates a city", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.city.update.mockResolvedValue({ ...cityRow, name: "Kalyan" });
      const result = await service.updateCity("city-1", { name: "Kalyan" });
      expect(result.name).toBe("Kalyan");
    });

    it("disables a city", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.city.update.mockResolvedValue({ ...cityRow, isActive: false });
      const result = await service.updateCity("city-1", { isActive: false });
      expect(result.isActive).toBe(false);
    });

    it("enables a city", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.city.update.mockResolvedValue({ ...cityRow, isActive: true });
      const result = await service.updateCity("city-1", { isActive: true });
      expect(result.isActive).toBe(true);
    });

    it("updating a missing city 404s", async () => {
      mockPrisma.city.findUnique.mockResolvedValue(null);
      await expect(
        service.updateCity("missing", { name: "X" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("refuses to delete a city that has areas", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.area.count.mockResolvedValue(3);
      await expect(service.deleteCity("city-1")).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.city.delete).not.toHaveBeenCalled();
    });

    it("refuses to delete a city referenced by customer addresses", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.area.count.mockResolvedValue(0);
      mockPrisma.customerAddress.count.mockResolvedValue(1);
      await expect(service.deleteCity("city-1")).rejects.toThrow(
        ConflictException,
      );
    });

    it("deletes a city with no dependents", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.city.delete.mockResolvedValue(cityRow);
      const result = await service.deleteCity("city-1");
      expect(result).toEqual({ id: "city-1", deleted: true });
    });
  });

  // ===== AREAS ==============================================================

  describe("areas", () => {
    it("creates an area under a valid active city", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({
        id: "city-1",
        isActive: true,
      });
      mockPrisma.area.create.mockResolvedValue(areaRow);
      const result = await service.createArea({
        cityId: "city-1",
        name: "Diva",
        pincode: "400612",
      });
      expect(mockPrisma.area.create).toHaveBeenCalledWith({
        data: { name: "Diva", cityId: "city-1", pincode: "400612" },
        select: expect.any(Object),
      });
      expect(result).toEqual(areaRow);
    });

    it("rejects an area under a missing city (404)", async () => {
      mockPrisma.city.findUnique.mockResolvedValue(null);
      await expect(
        service.createArea({ cityId: "missing", name: "Diva", pincode: "400612" }),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.area.create).not.toHaveBeenCalled();
    });

    it("rejects an area under an inactive city (409)", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({
        id: "city-1",
        isActive: false,
      });
      await expect(
        service.createArea({ cityId: "city-1", name: "Diva", pincode: "400612" }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects a duplicate area (P2002 -> 409)", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({
        id: "city-1",
        isActive: true,
      });
      mockPrisma.area.create.mockRejectedValue(uniqueError());
      await expect(
        service.createArea({ cityId: "city-1", name: "Diva", pincode: "400612" }),
      ).rejects.toThrow(ConflictException);
    });

    it("lists areas including inactive ones for a city", async () => {
      mockPrisma.city.findUnique.mockResolvedValue({ id: "city-1" });
      mockPrisma.area.findMany.mockResolvedValue([
        areaRow,
        { ...areaRow, id: "area-2", isActive: false },
      ]);
      const result = await service.getAdminAreas("city-1");
      expect(mockPrisma.area.findMany).toHaveBeenCalledWith({
        where: { cityId: "city-1" },
        orderBy: { name: "asc" },
        select: expect.any(Object),
      });
      expect(result).toHaveLength(2);
    });

    it("listing areas for a missing city 404s", async () => {
      mockPrisma.city.findUnique.mockResolvedValue(null);
      await expect(service.getAdminAreas("missing")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("updates an area name", async () => {
      mockPrisma.area.findUnique.mockResolvedValue({ id: "area-1" });
      mockPrisma.area.update.mockResolvedValue({ ...areaRow, name: "Mumbra" });
      const result = await service.updateArea("area-1", { name: "Mumbra" });
      expect(result.name).toBe("Mumbra");
    });

    it("updates an area pincode", async () => {
      mockPrisma.area.findUnique.mockResolvedValue({ id: "area-1" });
      mockPrisma.area.update.mockResolvedValue({ ...areaRow, pincode: "400700" });
      const result = await service.updateArea("area-1", { pincode: "400700" });
      expect(mockPrisma.area.update).toHaveBeenCalledWith({
        where: { id: "area-1" },
        data: { pincode: "400700" },
        select: expect.any(Object),
      });
      expect(result.pincode).toBe("400700");
    });

    it("disables an area", async () => {
      mockPrisma.area.findUnique.mockResolvedValue({ id: "area-1" });
      mockPrisma.area.update.mockResolvedValue({ ...areaRow, isActive: false });
      const result = await service.updateArea("area-1", { isActive: false });
      expect(result.isActive).toBe(false);
    });

    it("enables an area", async () => {
      mockPrisma.area.findUnique.mockResolvedValue({ id: "area-1" });
      mockPrisma.area.update.mockResolvedValue({ ...areaRow, isActive: true });
      const result = await service.updateArea("area-1", { isActive: true });
      expect(result.isActive).toBe(true);
    });

    it("updating a missing area 404s", async () => {
      mockPrisma.area.findUnique.mockResolvedValue(null);
      await expect(
        service.updateArea("missing", { name: "X" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("refuses to delete an area referenced by customer addresses", async () => {
      mockPrisma.area.findUnique.mockResolvedValue({ id: "area-1" });
      mockPrisma.customerAddress.count.mockResolvedValue(1);
      await expect(service.deleteArea("area-1")).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.area.delete).not.toHaveBeenCalled();
    });

    it("deletes an area with no dependents", async () => {
      mockPrisma.area.findUnique.mockResolvedValue({ id: "area-1" });
      mockPrisma.area.delete.mockResolvedValue(areaRow);
      const result = await service.deleteArea("area-1");
      expect(result).toEqual({ id: "area-1", deleted: true });
    });

    it("deleting a missing area 404s", async () => {
      mockPrisma.area.findUnique.mockResolvedValue(null);
      await expect(service.deleteArea("missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
