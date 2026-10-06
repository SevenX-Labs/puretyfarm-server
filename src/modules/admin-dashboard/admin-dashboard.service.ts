import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminDashboardOverviewQueryDto } from './dto/admin-dashboard-overview-query.dto';

interface DateRange {
  from: Date;
  to: Date;
}

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(query: AdminDashboardOverviewQueryDto) {
    const period = this.resolvePeriod(query);
    const previousPeriod = this.calculatePreviousPeriod(period);

    const [
      customers,
      orders,
      sales,
      revenue,
      plans,
      deliveries,
      wallet,
      profit,
      alerts,
      trend,
      prevCustomersNew,
      prevOrdersTotal,
      prevSalesTotal,
      prevRevenueCollected,
      prevGrossProfit,
    ] = await Promise.all([
      this.getCustomerMetrics(period),
      this.getOrderMetrics(period),
      this.getSalesMetrics(period),
      this.getRevenueMetrics(period),
      this.getPlanMetrics(period),
      this.getDeliveryMetrics(period),
      this.getWalletMetrics(period),
      this.getProfitMetrics(period),
      this.getAlerts(),
      this.getDailyTrend(period),
      this.getNewCustomerCount(previousPeriod),
      this.getOrderCount(previousPeriod),
      this.getSalesTotalPaise(previousPeriod),
      this.getRevenueCollectedPaise(previousPeriod),
      this.getGrossProfitPaise(previousPeriod),
    ]);

    const comparison = {
      previousPeriod: {
        from: this.formatDate(previousPeriod.from),
        to: this.formatDate(previousPeriod.to),
      },
      customersNewChangePercent: this.percentChange(customers.new, prevCustomersNew),
      ordersChangePercent: this.percentChange(orders.total, prevOrdersTotal),
      salesChangePercent: this.percentChange(sales.totalPaise, prevSalesTotal),
      revenueChangePercent: this.percentChange(revenue.collectedPaise, prevRevenueCollected),
      grossProfitChangePercent: this.percentChange(profit.grossProfitPaise, prevGrossProfit),
    };

    return {
      period: {
        from: this.formatDate(period.from),
        to: this.formatDate(period.to),
      },
      customers,
      orders,
      sales,
      revenue,
      plans,
      deliveries,
      wallet,
      profit,
      alerts,
      comparison,
      trend,
    };
  }

  private resolvePeriod(query: AdminDashboardOverviewQueryDto): DateRange {
    const today = new Date();
    const todayStr = this.formatDate(today);

    const fromStr = query.from || todayStr;
    const toStr = query.to || todayStr;

    return {
      from: new Date(fromStr + 'T00:00:00.000Z'),
      to: new Date(toStr + 'T23:59:59.999Z'),
    };
  }

  private calculatePreviousPeriod(period: DateRange): DateRange {
    const durationMs = period.to.getTime() - period.from.getTime();
    const prevTo = new Date(period.from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - durationMs);
    prevFrom.setUTCHours(0, 0, 0, 0);
    prevTo.setUTCHours(23, 59, 59, 999);
    return { from: prevFrom, to: prevTo };
  }

  private percentChange(current: number, previous: number): number {
    if (previous === 0) {
      return current === 0 ? 0 : 100;
    }
    return Math.round(((current - previous) / previous) * 10000) / 100;
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  // ── Customer Metrics ──
  // active = customers with an ACTIVE plan selection OR a qualifying order in the period.

  private async getCustomerMetrics(period: DateRange) {
    const [total, newCount, activePlanUserIds, orderUserIds] = await Promise.all([
      this.prisma.user.count({ where: { role: 'CUSTOMER' } }),
      this.getNewCustomerCount(period),
      this.prisma.planSelection.findMany({
        where: { status: 'ACTIVE' },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.prisma.order.findMany({
        where: {
          createdAt: { gte: period.from, lte: period.to },
          user: { role: 'CUSTOMER' },
          status: { notIn: ['CANCELLED', 'FAILED'] },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);

    const activePlanSet = new Set(activePlanUserIds.map(r => r.userId));
    const activeSet = new Set(activePlanSet);
    for (const r of orderUserIds) activeSet.add(r.userId);

    return {
      total,
      new: newCount,
      active: activeSet.size,
      withActivePlan: activePlanSet.size,
    };
  }

  private async getNewCustomerCount(period: DateRange): Promise<number> {
    return this.prisma.user.count({
      where: {
        role: 'CUSTOMER',
        createdAt: { gte: period.from, lte: period.to },
      },
    });
  }

  // ── Order Metrics ──

  private async getOrderMetrics(period: DateRange) {
    const where = {
      createdAt: { gte: period.from, lte: period.to },
    };

    const groups = await this.prisma.order.groupBy({
      by: ['status'],
      where,
      _count: { id: true },
    });

    const statusMap: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      statusMap[g.status] = g._count.id;
      total += g._count.id;
    }

    return {
      total,
      pending: statusMap['PENDING'] || 0,
      confirmed: statusMap['CONFIRMED'] || 0,
      processing: statusMap['PROCESSING'] || 0,
      outForDelivery: statusMap['OUT_FOR_DELIVERY'] || 0,
      delivered: statusMap['DELIVERED'] || 0,
      cancelled: statusMap['CANCELLED'] || 0,
      failed: statusMap['FAILED'] || 0,
    };
  }

  private async getOrderCount(period: DateRange): Promise<number> {
    return this.prisma.order.count({
      where: { createdAt: { gte: period.from, lte: period.to } },
    });
  }

  // ── Sales Metrics ──
  // Sales = value of customer purchases. Source of truth: PlanSelection.paidAmountPaise
  // for paid plan selections (avoids double-counting with prepaid orders).
  // For BUY_ONCE orders without a plan selection, use order.totalPaise.

  private async getSalesMetrics(period: DateRange) {
    const planSalesGroups = await this.prisma.planSelection.groupBy({
      by: ['planType'],
      where: {
        paidAt: { gte: period.from, lte: period.to },
        status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] },
        paidAmountPaise: { not: null },
      },
      _sum: { paidAmountPaise: true },
    });

    let buyOncePaise = 0;
    let trialPaise = 0;
    let monthlyPaise = 0;

    for (const g of planSalesGroups) {
      const amount = g._sum.paidAmountPaise || 0;
      switch (g.planType) {
        case 'BUY_ONCE': buyOncePaise = amount; break;
        case 'SEVEN_DAY_TRIAL': trialPaise = amount; break;
        case 'MONTHLY': monthlyPaise = amount; break;
      }
    }

    const totalPaise = buyOncePaise + trialPaise + monthlyPaise;

    return { totalPaise, buyOncePaise, trialPaise, monthlyPaise };
  }

  private async getSalesTotalPaise(period: DateRange): Promise<number> {
    const result = await this.prisma.planSelection.aggregate({
      where: {
        paidAt: { gte: period.from, lte: period.to },
        status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] },
        paidAmountPaise: { not: null },
      },
      _sum: { paidAmountPaise: true },
    });
    return result._sum.paidAmountPaise || 0;
  }

  // ── Revenue Metrics ──
  // Revenue = actual money collected for purchases.
  // Wallet payments for plans: WalletTransaction DEBIT with referenceType PLAN_SELECTION
  // Cash payments for plans: CashCollection with planSelectionId, status CONFIRMED
  // Wallet payments for orders: WalletTransaction DEBIT with referenceType ORDER
  // Wallet top-ups are NOT revenue.

  private async getRevenueMetrics(period: DateRange) {
    const [
      walletPlanRevenue,
      cashPlanRevenue,
      walletOrderRevenue,
      walletTopUps,
      pendingCash,
      refunds,
    ] = await Promise.all([
      // Wallet debits for plan selections
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'DEBIT',
          referenceType: 'PLAN_SELECTION',
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      // Confirmed cash collections for plans
      this.prisma.cashCollection.aggregate({
        where: {
          planSelectionId: { not: null },
          status: 'CONFIRMED',
          confirmedAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      // Wallet debits for orders
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'DEBIT',
          referenceType: 'ORDER',
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      // Wallet top-ups (CREDIT transactions from CREDIT_REQUEST)
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'CREDIT',
          referenceType: 'CREDIT_REQUEST',
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      // Pending cash collections
      this.prisma.cashCollection.aggregate({
        where: {
          status: { in: ['PENDING', 'COLLECTED'] },
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      // Refunds
      this.prisma.payment.aggregate({
        where: {
          status: 'REFUNDED',
          refundedAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
    ]);

    const walletPaise =
      (walletPlanRevenue._sum.amountPaise || 0) +
      (walletOrderRevenue._sum.amountPaise || 0);
    const cashPaise = cashPlanRevenue._sum.amountPaise || 0;
    const collectedPaise = walletPaise + cashPaise;

    // Revenue breakdown by plan type from wallet plan debits
    const walletPlanByType = await this.prisma.$queryRaw<
      { planType: string; total: bigint }[]
    >`
      SELECT ps."planType", SUM(wt."amountPaise")::bigint AS total
      FROM wallet_transactions wt
      JOIN plan_selections ps ON ps.id = wt."referenceId"
      WHERE wt.type = 'DEBIT'
        AND wt."referenceType" = 'PLAN_SELECTION'
        AND wt."createdAt" >= ${period.from}
        AND wt."createdAt" <= ${period.to}
      GROUP BY ps."planType"
    `;

    const cashPlanByType = await this.prisma.$queryRaw<
      { planType: string; total: bigint }[]
    >`
      SELECT ps."planType", SUM(cc."amountPaise")::bigint AS total
      FROM cash_collections cc
      JOIN plan_selections ps ON ps.id = cc."planSelectionId"
      WHERE cc."planSelectionId" IS NOT NULL
        AND cc.status = 'CONFIRMED'
        AND cc."confirmedAt" >= ${period.from}
        AND cc."confirmedAt" <= ${period.to}
      GROUP BY ps."planType"
    `;

    const revByType: Record<string, number> = {};
    for (const r of walletPlanByType) {
      revByType[r.planType] = (revByType[r.planType] || 0) + Number(r.total);
    }
    for (const r of cashPlanByType) {
      revByType[r.planType] = (revByType[r.planType] || 0) + Number(r.total);
    }

    return {
      collectedPaise,
      walletPaise,
      cashPaise,
      buyOncePaise: revByType['BUY_ONCE'] || 0,
      trialPaise: revByType['SEVEN_DAY_TRIAL'] || 0,
      monthlyPaise: revByType['MONTHLY'] || 0,
      walletTopUpsPaise: walletTopUps._sum.amountPaise || 0,
      pendingCashPaise: pendingCash._sum.amountPaise || 0,
      refundsPaise: refunds._sum.amountPaise || 0,
    };
  }

  private async getRevenueCollectedPaise(period: DateRange): Promise<number> {
    const [walletPlan, cashPlan, walletOrder] = await Promise.all([
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'DEBIT',
          referenceType: 'PLAN_SELECTION',
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      this.prisma.cashCollection.aggregate({
        where: {
          planSelectionId: { not: null },
          status: 'CONFIRMED',
          confirmedAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'DEBIT',
          referenceType: 'ORDER',
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
    ]);
    return (
      (walletPlan._sum.amountPaise || 0) +
      (cashPlan._sum.amountPaise || 0) +
      (walletOrder._sum.amountPaise || 0)
    );
  }

  // ── Plan Metrics ──

  private async getPlanMetrics(period: DateRange) {
    const [activeGroups, buyOnceCustomers, newSelections] = await Promise.all([
      this.prisma.planSelection.groupBy({
        by: ['planType'],
        where: { status: 'ACTIVE' },
        _count: { id: true },
      }),
      this.prisma.planSelection.groupBy({
        by: ['userId'],
        where: {
          planType: 'BUY_ONCE',
          status: { in: ['CONFIRMED', 'ACTIVE', 'COMPLETED'] },
        },
      }).then(r => r.length),
      this.prisma.planSelection.count({
        where: {
          createdAt: { gte: period.from, lte: period.to },
        },
      }),
    ]);

    const activeMap: Record<string, number> = {};
    for (const g of activeGroups) {
      activeMap[g.planType] = g._count.id;
    }

    return {
      activeMonthly: activeMap['MONTHLY'] || 0,
      activeTrial: activeMap['SEVEN_DAY_TRIAL'] || 0,
      buyOnceCustomers,
      newSelections,
    };
  }

  // ── Delivery Metrics ──

  private async getDeliveryMetrics(period: DateRange) {
    const groups = await this.prisma.planDelivery.groupBy({
      by: ['status'],
      where: {
        deliveryDate: { gte: period.from, lte: period.to },
      },
      _count: { id: true },
    });

    const statusMap: Record<string, number> = {};
    for (const g of groups) {
      statusMap[g.status] = g._count.id;
    }

    const scheduled = statusMap['SCHEDULED'] || 0;
    const delivered = statusMap['DELIVERED'] || 0;
    const skipped = statusMap['SKIPPED'] || 0;

    // Eligible = all deliveries (scheduled + delivered + skipped), excluding none
    // since the current schema only has SCHEDULED, SKIPPED, DELIVERED
    const eligible = scheduled + delivered + skipped;
    const completionPercent = eligible > 0
      ? Math.round((delivered / eligible) * 10000) / 100
      : 0;

    return {
      scheduled,
      delivered,
      skipped,
      cancelled: 0,
      failed: 0,
      completionPercent,
    };
  }

  // ── Wallet Metrics ──

  private async getWalletMetrics(period: DateRange) {
    const [balanceResult, topUpResult] = await Promise.all([
      this.prisma.wallet.aggregate({
        where: { user: { role: 'CUSTOMER' } },
        _sum: { balancePaise: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: {
          type: 'CREDIT',
          referenceType: 'CREDIT_REQUEST',
          createdAt: { gte: period.from, lte: period.to },
        },
        _sum: { amountPaise: true },
      }),
    ]);

    return {
      totalCustomerBalancePaise: balanceResult._sum.balancePaise || 0,
      walletTopUpsPaise: topUpResult._sum.amountPaise || 0,
    };
  }

  // ── Profit Metrics ──
  // The system has no actual procurement cost field. actualPricePerLitre is MRP,
  // not procurement cost. productCostPaise is 0 and costDataAvailable is false.
  // grossProfitPaise = salesPaise - deliveryCostPaise (contribution margin only).

  private async getProfitMetrics(period: DateRange) {
    const [salesResult, deliveryCostResult] = await Promise.all([
      this.prisma.planSelection.aggregate({
        where: {
          paidAt: { gte: period.from, lte: period.to },
          status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] },
          paidAmountPaise: { not: null },
        },
        _sum: { paidAmountPaise: true },
      }),
      this.prisma.order.aggregate({
        where: {
          createdAt: { gte: period.from, lte: period.to },
          status: { notIn: ['CANCELLED', 'FAILED'] },
        },
        _sum: { deliveryFeePaise: true },
      }),
    ]);

    const salesPaise = salesResult._sum.paidAmountPaise || 0;
    const deliveryCostPaise = deliveryCostResult._sum.deliveryFeePaise || 0;
    const productCostPaise = 0;

    const grossProfitPaise = salesPaise - productCostPaise - deliveryCostPaise;
    const grossMarginPercent = salesPaise > 0
      ? Math.round((grossProfitPaise / salesPaise) * 10000) / 100
      : 0;

    return {
      salesPaise,
      productCostPaise,
      deliveryCostPaise,
      grossProfitPaise,
      grossMarginPercent,
      costDataAvailable: false,
    };
  }

  private async getGrossProfitPaise(period: DateRange): Promise<number> {
    const [salesResult, deliveryCostResult] = await Promise.all([
      this.prisma.planSelection.aggregate({
        where: {
          paidAt: { gte: period.from, lte: period.to },
          status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] },
          paidAmountPaise: { not: null },
        },
        _sum: { paidAmountPaise: true },
      }),
      this.prisma.order.aggregate({
        where: {
          createdAt: { gte: period.from, lte: period.to },
          status: { notIn: ['CANCELLED', 'FAILED'] },
        },
        _sum: { deliveryFeePaise: true },
      }),
    ]);
    return (salesResult._sum.paidAmountPaise || 0) - (deliveryCostResult._sum.deliveryFeePaise || 0);
  }

  // ── Alerts ──

  private async getAlerts() {
    const [pendingCash, pendingWallet, pendingDelivery, failedOrders] = await Promise.all([
      this.prisma.cashCollection.count({
        where: { status: { in: ['PENDING', 'COLLECTED'] } },
      }),
      this.prisma.walletCreditRequest.count({
        where: { status: 'PENDING' },
      }),
      this.prisma.manageDeliveryChangeRequest.count({
        where: { status: 'PENDING' },
      }),
      this.prisma.order.count({
        where: { status: 'FAILED' },
      }),
    ]);

    return {
      pendingCashCollections: pendingCash,
      pendingWalletApprovals: pendingWallet,
      pendingDeliveryChangeRequests: pendingDelivery,
      failedOrders,
    };
  }

  // ── Daily Trend ──

  private async getDailyTrend(period: DateRange) {
    const days: string[] = [];
    const cursor = new Date(period.from);
    const end = new Date(period.to);
    end.setUTCHours(0, 0, 0, 0);
    while (cursor <= end) {
      days.push(this.formatDate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Fetch daily aggregates in parallel
    const [salesByDay, revenueByDay, profitDeliveryCostByDay, ordersByDay, deliveriesByDay] =
      await Promise.all([
        this.prisma.$queryRaw<{ day: Date; total: bigint }[]>`
          SELECT DATE("paidAt") AS day, SUM("paidAmountPaise")::bigint AS total
          FROM plan_selections
          WHERE "paidAt" >= ${period.from} AND "paidAt" <= ${period.to}
            AND status NOT IN ('CANCELLED', 'PENDING_PAYMENT')
            AND "paidAmountPaise" IS NOT NULL
          GROUP BY DATE("paidAt")
        `,
        this.prisma.$queryRaw<{ day: Date; total: bigint }[]>`
          SELECT DATE("createdAt") AS day, SUM("amountPaise")::bigint AS total
          FROM wallet_transactions
          WHERE type = 'DEBIT'
            AND "referenceType" IN ('PLAN_SELECTION', 'ORDER')
            AND "createdAt" >= ${period.from} AND "createdAt" <= ${period.to}
          GROUP BY DATE("createdAt")
        `,
        this.prisma.$queryRaw<{ day: Date; total: bigint }[]>`
          SELECT DATE("createdAt") AS day, SUM("deliveryFeePaise")::bigint AS total
          FROM orders
          WHERE "createdAt" >= ${period.from} AND "createdAt" <= ${period.to}
            AND status NOT IN ('CANCELLED', 'FAILED')
          GROUP BY DATE("createdAt")
        `,
        this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
          SELECT DATE("createdAt") AS day, COUNT(*)::bigint AS count
          FROM orders
          WHERE "createdAt" >= ${period.from} AND "createdAt" <= ${period.to}
          GROUP BY DATE("createdAt")
        `,
        this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
          SELECT "deliveryDate" AS day, COUNT(*)::bigint AS count
          FROM plan_deliveries
          WHERE "deliveryDate" >= ${period.from} AND "deliveryDate" <= ${period.to}
            AND status = 'DELIVERED'
          GROUP BY "deliveryDate"
        `,
      ]);

    const salesMap = this.toDayMap(salesByDay, 'total');
    const revenueMap = this.toDayMap(revenueByDay, 'total');
    const deliveryCostMap = this.toDayMap(profitDeliveryCostByDay, 'total');
    const ordersMap = this.toDayMap(ordersByDay, 'count');
    const deliveriesMap = this.toDayMap(deliveriesByDay, 'count');

    const daily = days.map((date) => {
      const salesPaise = salesMap[date] || 0;
      const deliveryCost = deliveryCostMap[date] || 0;
      return {
        date,
        salesPaise,
        revenueCollectedPaise: revenueMap[date] || 0,
        grossProfitPaise: salesPaise - deliveryCost,
        orders: ordersMap[date] || 0,
        deliveries: deliveriesMap[date] || 0,
      };
    });

    return { daily };
  }

  private toDayMap(
    rows: { day: Date; total?: bigint; count?: bigint }[],
    field: 'total' | 'count',
  ): Record<string, number> {
    const map: Record<string, number> = {};
    for (const row of rows) {
      const key = this.formatDate(row.day);
      map[key] = Number(row[field] ?? 0);
    }
    return map;
  }
}
