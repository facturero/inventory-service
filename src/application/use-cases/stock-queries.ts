import { Decimal } from 'decimal.js';
import { StockPosition, Warehouse } from '../../domain/entities.js';
import { StockListFilters } from '../../domain/repositories.js';
import type { UnitOfWork } from '../../domain/repositories.js';
import { Quantity } from '../../domain/value-objects.js';

export interface StockPositionView {
  id: string;
  organizationId: string;
  productId: string;
  warehouseId: string;
  warehouseCode: string;
  quantityOnHand: string;
  quantityReserved: string;
  quantityAvailable: string;
  averageCost: string;
  averageCostCents: number;
  currencyCode: string;
  updatedAt: Date;
}

function toStockPositionView(position: StockPosition, warehouse: Warehouse | null): StockPositionView {
  return {
    id: position.id,
    organizationId: position.organizationId,
    productId: position.productId,
    warehouseId: position.warehouseId,
    warehouseCode: warehouse?.code ?? '—',
    quantityOnHand: position.quantityOnHand.toFixed(),
    quantityReserved: position.quantityReserved.toFixed(),
    quantityAvailable: position.quantityAvailable.toFixed(),
    averageCost: position.averageCost.toDecimalString(),
    averageCostCents: position.averageCost.toCents(),
    currencyCode: position.currencyCode,
    updatedAt: position.updatedAt,
  };
}

async function warehouseMap(repos: UnitOfWork, organizationId: string): Promise<Map<string, Warehouse>> {
  const warehouses = await repos.warehouses.listByOrganization(organizationId);
  return new Map(warehouses.map((w) => [w.id, w]));
}

export class GetStockByProductUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(organizationId: string, productId: string) {
    const positions = await this.repos.stockPositions.findByProduct(organizationId, productId);
    const warehouses = await warehouseMap(this.repos, organizationId);

    const totalOnHand = positions.reduce((acc, p) => acc.add(p.quantityOnHand), Quantity.fromNumber(0));
    const totalReserved = positions.reduce((acc, p) => acc.add(p.quantityReserved), Quantity.fromNumber(0));
    const totalAvailable = positions.reduce((acc, p) => acc.add(p.quantityAvailable), Quantity.fromNumber(0));

    return {
      productId,
      totalOnHand: totalOnHand.toFixed(),
      totalReserved: totalReserved.toFixed(),
      totalAvailable: totalAvailable.toFixed(),
      positions: positions.map((p) => toStockPositionView(p, warehouses.get(p.warehouseId) ?? null)),
    };
  }
}

export class GetStockSummaryUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(organizationId: string, filters: { productId?: string; warehouseId?: string; stockState?: StockListFilters['stockState']; page?: number; pageSize?: number }) {
    const { entries, total } = await this.repos.stockPositions.listStock(organizationId, {
      productId: filters.productId,
      warehouseId: filters.warehouseId,
      stockState: filters.stockState,
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 50,
    });
    const warehouses = await warehouseMap(this.repos, organizationId);

    return {
      data: entries.map((p) => toStockPositionView(p, warehouses.get(p.warehouseId) ?? null)),
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 50,
      total,
      staleWarning: await this.staleWarning(organizationId),
    };
  }

  /** Aviso de que las cifras no son confiables: hubo un hueco (módulo apagado)
   *  y todavía nadie hizo un conteo físico posterior. Sin esto, reactivar el
   *  plugin sería silencioso y el usuario creería datos falsos. */
  private async staleWarning(organizationId: string) {
    const gap = await this.repos.inventoryGaps.findLastClosedGap(organizationId);
    if (!gap || gap.endedAt === null) return null;
    const resolved = await this.repos.stockMovements.hasReconcilingMovementAfter(organizationId, gap.endedAt);
    if (resolved) return null;
    return {
      startedAt: gap.startedAt.toISOString(),
      endedAt: gap.endedAt.toISOString(),
      skippedMovements: gap.skippedMovements,
    };
  }
}

export class GetStockMovementsUseCase {
  constructor(private readonly repos: UnitOfWork) {}

  async execute(organizationId: string, filters: { productId: string; warehouseId?: string; type?: string; referenceType?: string; referenceId?: string; from?: string; to?: string; page?: number; pageSize?: number }) {
    const from = filters.from ? new Date(filters.from) : undefined;
    const to = filters.to ? new Date(filters.to) : undefined;
    const { entries, total } = await this.repos.stockMovements.listMovements(organizationId, {
      productId: filters.productId,
      warehouseId: filters.warehouseId,
      type: filters.type as never,
      referenceType: filters.referenceType,
      referenceId: filters.referenceId,
      from,
      to,
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 50,
    });
    return {
      data: entries.map((m) => ({
        id: m.id,
        productId: m.productId,
        warehouseId: m.warehouseId,
        type: m.type,
        quantity: m.quantity.toFixed(),
        unitCost: m.unitCostCents === null ? null : toDecimal(m.unitCostCents),
        unitCostCents: m.unitCostCents,
        totalCost: m.totalCostCents === null ? null : toDecimal(m.totalCostCents),
        totalCostCents: m.totalCostCents,
        currencyCode: m.currencyCode,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        accountingNature: m.accountingNature,
        reasonCode: m.reasonCode,
        lotId: m.lotId,
        notes: m.notes,
        createdBy: m.createdBy,
        createdAt: m.createdAt,
      })),
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 50,
      total,
    };
  }
}

function toDecimal(cents: number): string {
  // La base es centavos; todas las monedas soportadas usan exponente 2.
  return new Decimal(cents).dividedBy(100).toFixed(2);
}