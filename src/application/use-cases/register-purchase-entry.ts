import { Money, Quantity } from '../../domain/value-objects.js';
import { WarehouseNotFoundError } from '../../domain/errors.js';
import { stockEnteredEvent } from '../events.js';
import { applyStockEntry } from '../stock-ops.js';
import type { UnitOfWorkGateway } from '../ports.js';

export interface PurchaseReceivedPayload {
  purchaseOrderId: string;
  organizationId: string;
  warehouseId: string;
  lines: { productId: string; quantity: string; unitCostCents: number; currencyCode: string }[];
}

/** (Consumido, FUTURO) Entrada de stock por recepción de compra. Escrito por
 *  adelantado: no existe servicio de compras, así que hoy nadie publica este
 *  evento. Aplica la estrategia de valorización por línea. */
export class RegisterPurchaseEntryUseCase {
  constructor(private readonly uow: UnitOfWorkGateway, private readonly systemUserId: string) {}

  async execute(payload: PurchaseReceivedPayload): Promise<number> {
    const uow = await this.uow.begin();
    let created = 0;
    try {
      const warehouse = await uow.warehouses.findById(payload.warehouseId);
      if (!warehouse || !warehouse.belongsToOrganization(payload.organizationId)) {
        throw new WarehouseNotFoundError();
      }
      for (const line of payload.lines) {
        const product = await uow.products.findById(payload.organizationId, line.productId);
        if (!product || !product.carriesStock()) {
          // Línea de producto sin stock: no se registra, no rompe la recepción.
          continue;
        }
        const result = await applyStockEntry(uow, {
          organizationId: payload.organizationId,
          warehouseId: payload.warehouseId,
          product,
          quantity: Quantity.fromString(line.quantity),
          unitCost: Money.fromCents(line.unitCostCents, line.currencyCode),
          type: 'purchase_in',
          accountingNature: 'inventory_in',
          referenceType: 'purchase_order',
          referenceId: payload.purchaseOrderId,
          createdBy: this.systemUserId,
        });
        await uow.outbox.add(stockEnteredEvent(result.movement, result.position));
        created += 1;
      }
      await uow.commit();
      return created;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}