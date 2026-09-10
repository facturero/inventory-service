import { Decimal } from 'decimal.js';
import { StockMovement, Warehouse } from '../../domain/entities.js';

/** Va de la entidad al JSON del openapi. Los casos de uso devuelven entidades;
 *  serializar aquí mantiene el contrato fuera del dominio. */

function centsToDecimalString(cents: number): string {
  // La base es centavos; todas las monedas soportadas usan exponente 2.
  return new Decimal(cents).dividedBy(100).toFixed(2);
}

export function toWarehouseJSON(w: Warehouse) {
  return {
    id: w.id,
    organizationId: w.organizationId,
    establishmentId: w.establishmentId,
    code: w.code,
    name: w.name,
    address: w.address,
    isDefault: w.isDefault,
    status: w.status,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function toStockMovementJSON(m: StockMovement) {
  return {
    id: m.id,
    productId: m.productId,
    warehouseId: m.warehouseId,
    type: m.type,
    quantity: m.quantity.toFixed(),
    unitCost: m.unitCostCents === null ? null : centsToDecimalString(m.unitCostCents),
    unitCostCents: m.unitCostCents,
    totalCost: m.totalCostCents === null ? null : centsToDecimalString(m.totalCostCents),
    totalCostCents: m.totalCostCents,
    currencyCode: m.currencyCode,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    accountingNature: m.accountingNature,
    reasonCode: m.reasonCode,
    lotId: m.lotId,
    notes: m.notes,
    createdBy: m.createdBy,
    createdAt: m.createdAt.toISOString(),
  };
}