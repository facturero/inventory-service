import { randomUUID } from 'node:crypto';
import { Money, Quantity } from '../../domain/value-objects.js';
import { ProductNotTrackedError, ProductNotFoundError, SameWarehouseTransferError, WarehouseNotFoundError } from '../../domain/errors.js';
import { StockMovement } from '../../domain/entities.js';
import { stockTransferredEvent } from '../events.js';
import { applyStockEntry, applyStockExit } from '../stock-ops.js';
import type { UnitOfWorkGateway } from '../ports.js';

export class TransferStockUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: {
    organizationId: string;
    productId: string;
    fromWarehouseId: string;
    toWarehouseId: string;
    quantity: string;
    notes?: string;
    createdBy: string;
  }): Promise<{ outMovement: StockMovement; inMovement: StockMovement }> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new SameWarehouseTransferError();
    }

    const uow = await this.uow.begin();
    const transferId = randomUUID();
    try {
      const [fromWh, toWh] = await Promise.all([
        uow.warehouses.findById(input.fromWarehouseId),
        uow.warehouses.findById(input.toWarehouseId),
      ]);
      if (!fromWh || !fromWh.belongsToOrganization(input.organizationId)) throw new WarehouseNotFoundError();
      if (!toWh || !toWh.belongsToOrganization(input.organizationId)) throw new WarehouseNotFoundError();
      if (fromWh.status !== 'active' || toWh.status !== 'active') throw new WarehouseNotFoundError();

      const product = await uow.products.findById(input.organizationId, input.productId);
      if (!product) throw new ProductNotFoundError();
      if (!product.carriesStock()) throw new ProductNotTrackedError();

      const quantity = Quantity.fromString(input.quantity);
      const notes = input.notes ?? null;

      // Origen: sale al costo de la estrategia (promedio o FIFO). Con
      // checkStock=true, mover más de lo que hay se niega.
      const out = await applyStockExit(uow, {
        organizationId: input.organizationId,
        warehouseId: input.fromWarehouseId,
        product,
        quantity,
        type: 'transfer_out',
        accountingNature: 'internal_transfer',
        referenceType: 'transfer',
        referenceId: transferId,
        notes,
        createdBy: input.createdBy,
        checkStock: true,
      });

      // Destino: entra al costo transferido (mantiene la valorización) con el
      // método de valorización del DESTINO.
      const transferredUnitCost = Money.fromCents(out.cost.unitCostCents, out.position.currencyCode);
      const inRes = await applyStockEntry(uow, {
        organizationId: input.organizationId,
        warehouseId: input.toWarehouseId,
        product,
        quantity,
        unitCost: transferredUnitCost,
        type: 'transfer_in',
        accountingNature: 'internal_transfer',
        referenceType: 'transfer',
        referenceId: transferId,
        notes,
        createdBy: input.createdBy,
      });

      // UN solo evento para las dos filas de kardex: el traslado es una acción
      // del usuario, no dos.
      await uow.outbox.add(
        stockTransferredEvent({
          organizationId: input.organizationId,
          productId: input.productId,
          fromWarehouseId: input.fromWarehouseId,
          toWarehouseId: input.toWarehouseId,
          quantity,
          outMovementId: out.movement.id,
          inMovementId: inRes.movement.id,
          unitCostCents: out.cost.unitCostCents,
          currencyCode: out.position.currencyCode,
        }),
      );

      await uow.commit();
      return { outMovement: out.movement, inMovement: inRes.movement };
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}