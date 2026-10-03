// @nestjs/config ships ESM-only; mock it so the CommonJS test runner can load
// the service graph (GeoapifyService imports ConfigService).
jest.mock("@nestjs/config", () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { LocationsService } from "./locations.service";
import { PrismaService } from "../../prisma/prisma.service";
import { GeoapifyService } from "./geoapify/geoapify.service";
import { NotFoundException } from "@nestjs/common";

describe("LocationsService", () => {
  let service: LocationsService;

  const mockPrisma = {
    state: { findMany: jest.fn(), findFirst: jest.fn() },
    city: { findMany: jest.fn(), findFirst: jest.fn() },
    area: { findMany: jest.fn() },
  };

  const mockGeoapify = { reverseGeocode: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: GeoapifyService, useValue: mockGeoapify },
      ],
    }).compile();
    service = module.get<LocationsService>(LocationsService);
  });

  describe("detectLocation", () => {
    it("delegates to GeoapifyService and returns the resolved location", async () => {
      const resolved = {
        latitude: 19.076,
        longitude: 72.8777,
        state: "Maharashtra",
        city: "Mumbai",
        area: "Bandra",
        pincode: "400050",
        country: "India",
        formattedAddress: "Bandra, Mumbai",
      };
      mockGeoapify.reverseGeocode.mockResolvedValue(resolved);

      const result = await service.detectLocation(19.076, 72.8777);

      expect(mockGeoapify.reverseGeocode).toHaveBeenCalledWith(19.076, 72.8777);
      expect(result).toBe(resolved);
    });
  });

  describe("getStates", () => {
    it("16a. returns only active states", async () => {
      mockPrisma.state.findMany.mockResolvedValue([
        { id: "s1", name: "Maharashtra" },
      ]);

      const result = await service.getStates();

      expect(result).toEqual([{ id: "s1", name: "Maharashtra" }]);
      expect(mockPrisma.state.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } }),
      );
    });
  });

  describe("getCities", () => {
    it("13. returns active cities for an active state", async () => {
      mockPrisma.state.findFirst.mockResolvedValue({ id: "s1" });
      mockPrisma.city.findMany.mockResolvedValue([
        { id: "c1", name: "Mumbai", stateId: "s1" },
      ]);

      const result = await service.getCities("s1");

      expect(result).toEqual([{ id: "c1", name: "Mumbai", stateId: "s1" }]);
      expect(mockPrisma.city.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { stateId: "s1", isActive: true } }),
      );
    });

    it("14. throws NotFound for a missing/inactive state (invalid state)", async () => {
      mockPrisma.state.findFirst.mockResolvedValue(null);
      await expect(service.getCities("bad")).rejects.toThrow(NotFoundException);
      expect(mockPrisma.city.findMany).not.toHaveBeenCalled();
    });
  });

  describe("getAreas", () => {
    it("14b. returns active areas for an active city", async () => {
      mockPrisma.city.findFirst.mockResolvedValue({ id: "c1" });
      mockPrisma.area.findMany.mockResolvedValue([
        { id: "a1", name: "Bandra", cityId: "c1", pincode: "400050" },
      ]);

      const result = await service.getAreas("c1");

      expect(result).toEqual([
        { id: "a1", name: "Bandra", cityId: "c1", pincode: "400050" },
      ]);
      expect(mockPrisma.area.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { cityId: "c1", isActive: true } }),
      );
    });

    it("15. throws NotFound for a missing/inactive city (invalid city)", async () => {
      mockPrisma.city.findFirst.mockResolvedValue(null);
      await expect(service.getAreas("bad")).rejects.toThrow(NotFoundException);
      expect(mockPrisma.area.findMany).not.toHaveBeenCalled();
    });
  });
});
