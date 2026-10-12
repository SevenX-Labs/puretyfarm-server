import {
  Injectable,
  Logger,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CustomerEventType,
  AdminEventType,
  CUSTOMER_EVENT_TYPES,
  ADMIN_EVENT_TYPES,
  RealtimePayload,
} from './constants/event-catalog';
import type {
  RealtimeBus,
  RealtimeMessage,
} from './interfaces/realtime-bus.interface';

interface ActiveStreamConnection {
  id: string;
  userId: string;
  role: 'CUSTOMER' | 'ADMIN';
  res: Response;
  pingTimer: NodeJS.Timeout;
  expiryTimer?: NodeJS.Timeout;
  createdAt: number;
  close: () => void;
}

@Injectable()
export class RealtimeEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimeEventsService.name);

  private readonly customerConnections = new Map<string, Set<ActiveStreamConnection>>();
  private readonly adminConnections = new Map<string, Set<ActiveStreamConnection>>();
  private totalConnectionsCount = 0;
  private eventIdCounter = 0;

  private readonly maxConnectionsTotal: number;
  private readonly maxConnectionsPerUser = 5;
  private readonly unsubscribeBus: () => void;

  constructor(
    @Inject('REALTIME_BUS')
    private readonly bus: RealtimeBus,
    @Optional() private readonly configService?: ConfigService,
  ) {
    const configuredMax = parseInt(
      this.configService?.get<string>('REALTIME_MAX_CONNECTIONS') || process.env.REALTIME_MAX_CONNECTIONS || '1000',
      10,
    );
    this.maxConnectionsTotal = isNaN(configuredMax) ? 1000 : configuredMax;

    this.unsubscribeBus = this.bus.subscribe((message) => {
      this.handleBusMessage(message);
    });
  }

  onModuleDestroy() {
    try {
      this.unsubscribeBus?.();
    } catch {}

    for (const [, conns] of this.customerConnections) {
      for (const conn of conns) {
        conn.close();
      }
    }
    this.customerConnections.clear();

    for (const [, conns] of this.adminConnections) {
      for (const conn of conns) {
        conn.close();
      }
    }
    this.adminConnections.clear();
    this.totalConnectionsCount = 0;
  }

  // ══════════════════════════════════════════════════════════════════
  //  FIRE-AND-FORGET PUBLISH APIS
  // ══════════════════════════════════════════════════════════════════

  publishToCustomer(userId: string, types: CustomerEventType[]): void {
    if (!userId || !Array.isArray(types) || types.length === 0) return;
    try {
      const validTypes = types.filter((t) => CUSTOMER_EVENT_TYPES.includes(t));
      if (validTypes.length === 0) return;

      void this.bus
        .publish({
          targetType: 'customer',
          userId,
          types: validTypes,
          timestamp: Date.now(),
        })
        .catch((err) => {
          this.logger.error(`Error publishing to customer ${userId}`, err);
        });
    } catch (err) {
      this.logger.error(`Synchronous error publishing to customer ${userId}`, err);
    }
  }

  publishToAdmins(types: AdminEventType[]): void {
    if (!Array.isArray(types) || types.length === 0) return;
    try {
      const validTypes = types.filter((t) => ADMIN_EVENT_TYPES.includes(t));
      if (validTypes.length === 0) return;

      void this.bus
        .publish({
          targetType: 'admin',
          types: validTypes,
          timestamp: Date.now(),
        })
        .catch((err) => {
          this.logger.error('Error publishing to admins', err);
        });
    } catch (err) {
      this.logger.error('Synchronous error publishing to admins', err);
    }
  }

  broadcastToCustomers(types: CustomerEventType[]): void {
    if (!Array.isArray(types) || types.length === 0) return;
    try {
      const validTypes = types.filter((t) => CUSTOMER_EVENT_TYPES.includes(t));
      if (validTypes.length === 0) return;

      void this.bus
        .publish({
          targetType: 'broadcast_customers',
          types: validTypes,
          timestamp: Date.now(),
        })
        .catch((err) => {
          this.logger.error('Error broadcasting to customers', err);
        });
    } catch (err) {
      this.logger.error('Synchronous error broadcasting to customers', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  BUS MESSAGE DISPATCH
  // ══════════════════════════════════════════════════════════════════

  private handleBusMessage(message: RealtimeMessage): void {
    const payload: RealtimePayload = {
      v: 1,
      types: message.types,
      ts: message.timestamp || Date.now(),
    };

    if (message.targetType === 'customer' && message.userId) {
      const userConns = this.customerConnections.get(message.userId);
      if (userConns) {
        for (const conn of userConns) {
          this.sendEvent(conn.res, 'sync', payload);
        }
      }
    } else if (message.targetType === 'broadcast_customers') {
      for (const [, conns] of this.customerConnections) {
        for (const conn of conns) {
          this.sendEvent(conn.res, 'sync', payload);
        }
      }
    } else if (message.targetType === 'admin') {
      for (const [, conns] of this.adminConnections) {
        for (const conn of conns) {
          this.sendEvent(conn.res, 'sync', payload);
        }
      }
    }
  }

  private sendEvent(res: Response, eventName: string, data: RealtimePayload): void {
    try {
      const id = ++this.eventIdCounter;
      res.write(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      this.logger.warn('Error writing SSE event to client', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONNECTION HANDLING
  // ══════════════════════════════════════════════════════════════════

  handleStreamConnection(
    userId: string,
    role: 'CUSTOMER' | 'ADMIN',
    req: Request,
    res: Response,
    tokenExpSeconds?: number,
  ): void {
    if (this.totalConnectionsCount >= this.maxConnectionsTotal) {
      this.logger.warn(
        `Rejecting stream connection: global cap reached (${this.totalConnectionsCount}/${this.maxConnectionsTotal})`,
      );
      res.status(503).json({
        error: 'SERVICE_UNAVAILABLE',
        message: 'Real-time connection limit reached. Falling back to polling.',
      });
      return;
    }

    const store =
      role === 'ADMIN' ? this.adminConnections : this.customerConnections;

    let userConns = store.get(userId);
    if (!userConns) {
      userConns = new Set<ActiveStreamConnection>();
      store.set(userId, userConns);
    }

    // Evict oldest connection if per-user cap exceeded
    if (userConns.size >= this.maxConnectionsPerUser) {
      let oldest: ActiveStreamConnection | null = null;
      for (const c of userConns) {
        if (!oldest || c.createdAt < oldest.createdAt) {
          oldest = c;
        }
      }
      if (oldest) {
        this.logger.log(
          `Evicting oldest connection for ${role} ${userId} (cap: ${this.maxConnectionsPerUser})`,
        );
        oldest.close();
      }
    }

    // Write SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial ready event
    const initialPayload: RealtimePayload = {
      v: 1,
      types: [],
      ts: Date.now(),
    };
    res.write(`event: ready\ndata: ${JSON.stringify(initialPayload)}\n\n`);

    const connectionId = `${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let closed = false;

    // Heartbeat ping every 25 seconds
    const pingTimer = setInterval(() => {
      try {
        if (!closed) {
          res.write(': ping\n\n');
        }
      } catch {
        closeConnection();
      }
    }, 25000);

    // Auto-close on token expiration
    let expiryTimer: NodeJS.Timeout | undefined;
    if (tokenExpSeconds && typeof tokenExpSeconds === 'number') {
      const expMs = tokenExpSeconds * 1000;
      const msUntilExpiry = expMs - Date.now();
      if (msUntilExpiry <= 0) {
        // Token already expired
        clearInterval(pingTimer);
        res.end();
        return;
      }
      expiryTimer = setTimeout(() => {
        this.logger.log(`Closing stream connection ${connectionId}: access token expired`);
        closeConnection();
      }, msUntilExpiry);
    }

    const closeConnection = () => {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      if (expiryTimer) clearTimeout(expiryTimer);

      userConns?.delete(connection);
      if (userConns && userConns.size === 0) {
        store.delete(userId);
      }
      this.totalConnectionsCount = Math.max(0, this.totalConnectionsCount - 1);

      try {
        res.end();
      } catch {}
    };

    const connection: ActiveStreamConnection = {
      id: connectionId,
      userId,
      role,
      res,
      pingTimer,
      expiryTimer,
      createdAt: Date.now(),
      close: closeConnection,
    };

    userConns.add(connection);
    this.totalConnectionsCount++;

    req.on('close', () => {
      closeConnection();
    });
  }

  getConnectionStats(): { total: number; customers: number; admins: number } {
    let customerCount = 0;
    for (const [, conns] of this.customerConnections) {
      customerCount += conns.size;
    }
    let adminCount = 0;
    for (const [, conns] of this.adminConnections) {
      adminCount += conns.size;
    }
    return {
      total: this.totalConnectionsCount,
      customers: customerCount,
      admins: adminCount,
    };
  }
}
