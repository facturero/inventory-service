import { Money, Quantity } from '../../domain/value-objects.js';
import { ProductNotTrackedError, ProductNotFoundError, ValidationError, WarehouseNotFoundError } from '../../domain/errors.js';
import { StockMovement } from '../../domain/entities.js';
import { stockEnteredEvent } from '../events.js';
import { applyStockEntry } from '../stock-ops.js';
import type { UnitOfWorkGateway } from '../ports.js';

/** Saldo inicial de un producto en una bodega (migración de datos). Es su
 *  propio tipo de movimiento: NO es un ajuste, no pasa por la tabla de motivos.
 *  Además, es uno de los dos movimientos que RESUELVEN el hueco del plugin. */
export class SetOpeningBalanceUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: {
    organizationId: string;
    productId: string;
    warehouseId: string;
    quantity: string;
    unitCost: string;
    currencyCode?: string;
    createdBy: string;
  }): Promise<StockMovement> {
    const uow = await this.uow.begin();
    try {
      const warehouse = await uow.warehouses.findById(input.warehouseId);
      if (!warehouse || !warehouse.belongsToOrganization(input.organizationId)) {
        throw new WarehouseNotFoundError();
      }
      const product = await uow.products.findById(input.organizationId, input.productId);
      if (!product) throw new ProductNotFoundError();
      if (!product.carriesStock()) throw new ProductNotTrackedError();

      const quantity = Quantity.fromString(input.quantity);
      if (quantity.isNegative()) throw new ValidationError([{ field: 'quantity', message: 'El saldo inicial no puede ser negativo' }]);

      const result = await applyStockEntry(uow, {
        organizationId: input.organizationId,
        warehouseId: input.warehouseId,
        product,
        quantity,
        unitCost: Money.fromDecimalString(input.unitCost, input.currencyCode ?? 'USD'),
        type: 'opening_balance',
        accountingNature: 'inventory_in',
        referenceType: 'opening_balance',
        referenceId: null,
        createdBy: input.createdBy,
      });

      await uow.outbox.add(stockEnteredEvent(result.movement, result.position));
      await uow.commit();
      return result.movement;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}