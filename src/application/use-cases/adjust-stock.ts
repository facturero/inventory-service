import { Money, Quantity } from '../../domain/value-objects.js';
import { ProductNotTrackedError, ProductNotFoundError, ValidationError, WarehouseNotFoundError } from '../../domain/errors.js';
import { StockMovement } from '../../domain/entities.js';
import { accountingNatureForAdjustment } from '../reason-nature.js';
import { stockAdjustedEvent } from '../events.js';
import { applyStockEntry, applyStockExit } from '../stock-ops.js';
import type { UnitOfWorkGateway } from '../ports.js';
import type { StockPosition } from '../../domain/entities.js';

export class AdjustStockUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: {
    organizationId: string;
    productId: string;
    warehouseId: string;
    /** DECIMAL(18,4) con signo: positivo = entrada, negativo = salida. */
    quantity: string;
    reasonCode: string;
    reason?: string;
    unitCost?: string;
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
      if (quantity.isZero()) throw new ValidationError([{ field: 'quantity', message: 'Debe ser distinto de cero' }]);
      const positive = quantity.isPositive();
      const nature = accountingNatureForAdjustment(input.reasonCode, positive);

      const createdBy = input.createdBy;
      const notes = input.reason ?? null;

      let movement: StockMovement;
      let position: StockPosition;

      if (positive) {
        let unitCost: Money;
        if (input.unitCost !== undefined) {
          unitCost = Money.fromDecimalString(input.unitCost, input.currencyCode ?? 'USD');
        } else {
          // Sobrante de conteo: entra al promedio vigente; si la posición está
          // en cero, entra a costo cero. Cobrar un costo inventado para cuadrar
          // un conteo es peor que registrarlo a cero.
          const existing = await uow.stockPositions.find(input.organizationId, input.warehouseId, input.productId);
          unitCost = existing ? existing.averageCost : Money.fromCents(0, input.currencyCode ?? 'USD');
        }
        const result = await applyStockEntry(uow, {
          organizationId: input.organizationId,
          warehouseId: input.warehouseId,
          product,
          quantity,
          unitCost,
          type: 'adjustment_in',
          accountingNature: nature,
          referenceType: null,
          referenceId: null,
          reasonCode: input.reasonCode,
          notes,
          createdBy,
        });
        movement = result.movement;
        position = result.position;
      } else {
        const result = await applyStockExit(uow, {
          organizationId: input.organizationId,
          warehouseId: input.warehouseId,
          product,
          quantity: quantity.abs(),
          type: 'adjustment_out',
          accountingNature: nature,
          referenceType: null,
          referenceId: null,
          reasonCode: input.reasonCode,
          notes,
          createdBy,
          // Ajustar a la baja por debajo de cero sí se puede negar: es una
          // acción manual en curso, no una venta ya facturada.
          checkStock: true,
        });
        movement = result.movement;
        position = result.position;
      }

      await uow.outbox.add(stockAdjustedEvent(movement, position));
      await uow.commit();
      return movement;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}