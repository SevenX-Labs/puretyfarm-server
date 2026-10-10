// @nestjs/config ships ESM-only; mock it so the CommonJS test runner can load
// the service under test (matches the existing profile specs).
jest.mock('@nestjs/config', () => ({
  ConfigService: jest.fn().mockImplementation(() => ({ get: jest.fn() })),
}));

import { GeoapifyService } from './geoapify.service';
import { ServiceUnavailableException } from '@nestjs/common';

describe('GeoapifyService', () => {
  const API_KEY = 'test-secret-api-key-123';
  const BASE_URL = 'https://api.geoapify.com';

  let service: GeoapifyService;
  let configGet: jest.Mock;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    configGet = jest.fn((key: string) => {
      if (key === 'GEOAPIFY_API_KEY') return API_KEY;
      if (key === 'GEOAPIFY_BASE_URL') return BASE_URL;
      return undefined;
    });
    service = new GeoapifyService({ get: configGet } as any);

    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const okResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(body),
  });

  it('4. parses a successful Geoapify response into a normalized result', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [
          {
            state: 'Maharashtra',
            city: 'Mumbai',
            suburb: 'Bandra',
            postcode: '400050',
            country: 'India',
            formatted: 'Bandra, Mumbai, Maharashtra, India',
          },
        ],
      }),
    );

    const result = await service.reverseGeocode(19.076, 72.8777);

    expect(result).toEqual({
      latitude: 19.076,
      longitude: 72.8777,
      state: 'Maharashtra',
      city: 'Mumbai',
      area: 'Bandra',
      pincode: '400050',
      country: 'India',
      formattedAddress: 'Bandra, Mumbai, Maharashtra, India',
    });
  });

  it('5. handles missing fields safely (returns nulls, no throw)', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ results: [{ country: 'India' }] }),
    );

    const result = await service.reverseGeocode(19.076, 72.8777);

    expect(result.state).toBeNull();
    expect(result.city).toBeNull();
    expect(result.area).toBeNull();
    expect(result.pincode).toBeNull();
    expect(result.country).toBe('India');
    expect(result.formattedAddress).toBeNull();
  });

  it('5b. handles an empty results array safely', async () => {
    fetchMock.mockResolvedValue(okResponse({ results: [] }));

    const result = await service.reverseGeocode(0, 0);

    expect(result.state).toBeNull();
    expect(result.city).toBeNull();
    expect(result.country).toBeNull();
  });

  it('falls back through alternative city/area keys', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        results: [{ county: 'Pune District', neighbourhood: 'Kothrud' }],
      }),
    );

    const result = await service.reverseGeocode(18.5, 73.8);

    expect(result.city).toBe('Pune District');
    expect(result.area).toBe('Kothrud');
  });

  it('6. throws ServiceUnavailable on an upstream HTTP error status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: jest.fn(),
    });

    await expect(service.reverseGeocode(19.076, 72.8777)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('7. throws ServiceUnavailable on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.reverseGeocode(19.076, 72.8777)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('7b. throws ServiceUnavailable on a timeout (AbortError)', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    fetchMock.mockRejectedValue(abortErr);

    await expect(service.reverseGeocode(19.076, 72.8777)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('8. throws ServiceUnavailable when the API key is not configured', async () => {
    configGet.mockImplementation((key: string) =>
      key === 'GEOAPIFY_BASE_URL' ? BASE_URL : undefined,
    );

    await expect(service.reverseGeocode(19.076, 72.8777)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the API key in the request URL but never returns it', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ results: [{ state: 'Goa', postcode: '403001' }] }),
    );

    const result = await service.reverseGeocode(15.4, 73.8);

    // The key is sent to Geoapify...
    const calledUrl = fetchMock.mock.calls[0][0] as URL;
    expect(calledUrl.toString()).toContain(`apiKey=${API_KEY}`);

    // ...but never leaks into the normalized result returned to the client.
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });
});
