import { randomUUID } from 'node:crypto';
import type { StockMovement, StockPosition, Warehouse } from '../domain/entities.js';
import type { DomainEvent } from '../domain/repositories.js';

/** Construye un DomainEvent con el envelope de bitácora (eventId/type/occurredAt). */
export function domainEvent(params: {
  type: string;
  aggregateType: string;
  aggregateId: string;
  organizationId: string;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    eventId: randomUUID(),
    aggregateType: params.aggregateType,
    aggregateId: params.aggregateId,
    type: params.type,
    payload: {
      ...params.payload,
      // La bitácora exige organizationId en el payload de todo mensaje.
      organizationId: params.organizationId,
    },
    occurredAt: new Date(),
  };
}

/** Payload estándar de movimiento, compartido por entered/consumed/adjusted. */
export function movementPayload(movement: StockMovement, position: StockPosition): Record<string, unknown> {
  return {
    movementId: movement.id,
    organizationId: movement.organizationId,
    productId: movement.productId,
    warehouseId: movement.warehouseId,
    type: movement.type,
    quantity: movement.quantity.toFixed(),
    unitCostCents: movement.unitCostCents,
    totalCostCents: movement.totalCostCents,
    currencyCode: movement.currencyCode,
    referenceType: movement.referenceType,
    referenceId: movement.referenceId,
    accountingNature: movement.accountingNature,
    reasonCode: movement.reasonCode,
    lotId: movement.lotId,
    newOnHand: position.quantityOnHand.toFixed(),
    newAverageCostCents: position.averageCost.toCents(),
  };
}

export function warehouseCreatedEvent(warehouse: Warehouse): DomainEvent {
  const p = warehouse.toPersistence();
  return domainEvent({
    type: 'inventory.warehouse.created',
    aggregateType: 'warehouse',
    aggregateId: warehouse.id,
    organizationId: warehouse.organizationId,
    payload: {
      warehouseId: p.id,
      establishmentId: p.establishmentId,
      code: p.code,
      name: p.name,
      isDefault: p.isDefault,
    },
  });
}

export function stockEnteredEvent(movement: StockMovement, position: StockPosition): DomainEvent {
  return domainEvent({
    type: 'inventory.stock.entered',
    aggregateType: `${movement.productId}:${movement.warehouseId}`,
    aggregateId: movement.id,
    organizationId: movement.organizationId,
    payload: movementPayload(movement, position),
  });
}

export function stockConsumedEvent(movement: StockMovement, position: StockPosition): DomainEvent {
  return domainEvent({
    type: 'inventory.stock.consumed',
    aggregateType: `${movement.productId}:${movement.warehouseId}`,
    aggregateId: movement.id,
    organizationId: movement.organizationId,
    payload: movementPayload(movement, position),
  });
}

export function stockAdjustedEvent(movement: StockMovement, position: StockPosition): DomainEvent {
  return domainEvent({
    type: 'inventory.stock.adjusted',
    aggregateType: `${movement.productId}:${movement.warehouseId}`,
    aggregateId: movement.id,
    organizationId: movement.organizationId,
    payload: movementPayload(movement, position),
  });
}

export function stockTransferredEvent(params: {
  organizationId: string;
  productId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: StockMovement['quantity'];
  outMovementId: string;
  inMovementId: string;
  unitCostCents: number;
  currencyCode: string;
}): DomainEvent {
  return domainEvent({
    type: 'inventory.stock.transferred',
    aggregateType: `${params.productId}:${params.fromWarehouseId}:${params.toWarehouseId}`,
    aggregateId: params.outMovementId,
    organizationId: params.organizationId,
    payload: {
      productId: params.productId,
      fromWarehouseId: params.fromWarehouseId,
      toWarehouseId: params.toWarehouseId,
      quantity: params.quantity.toFixed(),
      outMovementId: params.outMovementId,
      inMovementId: params.inMovementId,
      unitCostCents: params.unitCostCents,
      currencyCode: params.currencyCode,
    },
  });
}

export function stockNegativeEvent(params: {
  organizationId: string;
  productId: string;
  warehouseId: string;
  currentOnHand: StockMovement['quantity'];
  allowNegativeStock: boolean;
}): DomainEvent {
  return domainEvent({
    type: 'inventory.stock.negative',
    aggregateType: `${params.productId}:${params.warehouseId}`,
    aggregateId: randomUUID(),
    organizationId: params.organizationId,
    payload: {
      productId: params.productId,
      warehouseId: params.warehouseId,
      currentOnHand: params.currentOnHand.toFixed(),
      allowNegativeStock: params.allowNegativeStock,
    },
  });
}

export function stockStaleEvent(params: {
  organizationId: string;
  startedAt: Date;
  endedAt: Date;
  skippedMovements: number;
}): DomainEvent {
  return domainEvent({
    type: 'inventory.stock.stale',
    aggregateType: 'inventory_gap',
    aggregateId: randomUUID(),
    organizationId: params.organizationId,
    payload: {
      startedAt: params.startedAt.toISOString(),
      endedAt: params.endedAt.toISOString(),
      skippedMovements: params.skippedMovements,
    },
  });
}