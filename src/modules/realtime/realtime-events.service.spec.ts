import { RealtimeEventsService } from './realtime-events.service';
import { InMemoryRealtimeBus } from './buses/in-memory-realtime-bus';
import { EventEmitter } from 'events';

describe('RealtimeEventsService', () => {
  let service: RealtimeEventsService;
  let bus: InMemoryRealtimeBus;

  const createMockResponse = () => {
    const res: any = new EventEmitter();
    res.writeHead = jest.fn();
    res.flushHeaders = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn();
    res.status = jest.fn().mockReturnThis();
    res.json = jest.fn().mockReturnThis();
    return res;
  };

  const createMockRequest = () => {
    return new EventEmitter();
  };

  beforeEach(() => {
    bus = new InMemoryRealtimeBus();
    service = new RealtimeEventsService(bus, {
      get: jest.fn().mockReturnValue('1000'),
    } as any);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('Connection Handling & Stream Lifecycle', () => {
    it('sends initial ready event on connect', () => {
      const req = createMockRequest();
      const res = createMockResponse();

      service.handleStreamConnection('user-1', 'CUSTOMER', req as any, res as any);

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      }));
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('event: ready\n'));
    });

    it('enforces per-user connection cap by evicting oldest connection', () => {
      const connections: any[] = [];
      const reqs: any[] = [];

      for (let i = 0; i < 6; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        reqs.push(req);
        connections.push(res);
        service.handleStreamConnection('user-1', 'CUSTOMER', req as any, res as any);
      }

      // The 1st connection should have been closed/evicted
      expect(connections[0].end).toHaveBeenCalled();
      // Total connections should be 5
      expect(service.getConnectionStats().customers).toBe(5);
    });

    it('cleans up connection on client disconnect (req close)', () => {
      const req = createMockRequest();
      const res = createMockResponse();

      service.handleStreamConnection('user-1', 'CUSTOMER', req as any, res as any);
      expect(service.getConnectionStats().customers).toBe(1);

      req.emit('close');
      expect(service.getConnectionStats().customers).toBe(0);
    });

    it('closes the stream when the access token exp passes', () => {
      jest.useFakeTimers();
      const req = createMockRequest();
      const res = createMockResponse();

      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = nowSec + 10; // expires in 10s

      service.handleStreamConnection('user-1', 'CUSTOMER', req as any, res as any, expSec);

      expect(res.end).not.toHaveBeenCalled();

      // Fast forward past expiry
      jest.advanceTimersByTime(11000);
      expect(res.end).toHaveBeenCalled();

      jest.useRealTimers();
    });
  });

  describe('Isolation & Event Routing', () => {
    it('isolates user events: user A never receives user B events', async () => {
      const reqA = createMockRequest();
      const resA = createMockResponse();
      const reqB = createMockRequest();
      const resB = createMockResponse();

      service.handleStreamConnection('user-A', 'CUSTOMER', reqA as any, resA as any);
      service.handleStreamConnection('user-B', 'CUSTOMER', reqB as any, resB as any);

      // Publish to user A
      service.publishToCustomer('user-A', ['wallet.updated']);
      await new Promise((r) => setImmediate(r));

      // User A receives sync event with wallet.updated
      expect(resA.write).toHaveBeenCalledWith(
        expect.stringMatching(/event: sync\ndata:.*wallet\.updated/),
      );

      // User B should NOT receive any sync event
      const bSyncCalls = resB.write.mock.calls.filter((call: any[]) =>
        call[0].includes('event: sync'),
      );
      expect(bSyncCalls.length).toBe(0);
    });

    it('admin and customer streams do not receive each others events', async () => {
      const reqCust = createMockRequest();
      const resCust = createMockResponse();
      const reqAdmin = createMockRequest();
      const resAdmin = createMockResponse();

      service.handleStreamConnection('cust-1', 'CUSTOMER', reqCust as any, resCust as any);
      service.handleStreamConnection('admin-1', 'ADMIN', reqAdmin as any, resAdmin as any);

      // Publish customer event
      service.publishToCustomer('cust-1', ['orders.updated']);
      await new Promise((r) => setImmediate(r));

      // Publish admin event
      service.publishToAdmins(['admin.orders.updated']);
      await new Promise((r) => setImmediate(r));

      // Customer receives orders.updated, but NOT admin.orders.updated
      const custWrites = resCust.write.mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(custWrites).toContain('orders.updated');
      expect(custWrites).not.toContain('admin.orders.updated');

      // Admin receives admin.orders.updated, but NOT customer orders.updated
      const adminWrites = resAdmin.write.mock.calls.map((c: any[]) => c[0]).join('\n');
      expect(adminWrites).toContain('admin.orders.updated');
      expect(adminWrites).not.toContain('"types":["orders.updated"]');
    });

    it('broadcasts plans.catalog.updated to all connected customers', async () => {
      const req1 = createMockRequest();
      const res1 = createMockResponse();
      const req2 = createMockRequest();
      const res2 = createMockResponse();

      service.handleStreamConnection('user-1', 'CUSTOMER', req1 as any, res1 as any);
      service.handleStreamConnection('user-2', 'CUSTOMER', req2 as any, res2 as any);

      service.broadcastToCustomers(['plans.catalog.updated']);
      await new Promise((r) => setImmediate(r));

      expect(res1.write).toHaveBeenCalledWith(
        expect.stringMatching(/plans\.catalog\.updated/),
      );
      expect(res2.write).toHaveBeenCalledWith(
        expect.stringMatching(/plans\.catalog\.updated/),
      );
    });
  });

  describe('Resilience & Fire-and-Forget Safety', () => {
    it('never propagates bus publish errors to the caller', () => {
      jest.spyOn(bus, 'publish').mockImplementation(() => {
        throw new Error('Bus crashed catastrophically');
      });

      expect(() => {
        service.publishToCustomer('user-1', ['wallet.updated']);
      }).not.toThrow();

      expect(() => {
        service.publishToAdmins(['admin.wallets.updated']);
      }).not.toThrow();

      expect(() => {
        service.broadcastToCustomers(['plans.catalog.updated']);
      }).not.toThrow();
    });
  });
});
