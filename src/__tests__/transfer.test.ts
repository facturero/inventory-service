import { describe, expect, it } from 'vitest';
import { TransferStockUseCase } from '../application/use-cases/transfer-stock.js';
import { InsufficientStockError, SameWarehouseTransferError } from '../domain/errors.js';
import { StockPosition } from '../domain/entities.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedPosition, seedProduct, seedWarehouse } from './helpers.js';

describe('TransferStock', () => {
  it('genera dos movimientos atómicos con internal_transfer y mismo transferId', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'A' });
    seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'B' });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '10.0000', averageCostCents: 1200 });

    const { outMovement, inMovement } = await new TransferStockUseCase(inMemoryGateway(uow)).execute({
      organizationId: UUID.ORG,
      productId: UUID.PRODUCT,
      fromWarehouseId: UUID.WH,
      toWarehouseId: UUID.WH2,
      quantity: '4.0000',
      createdBy: UUID.USER,
    });

    expect(outMovement.type).toBe('transfer_out');
    expect(inMovement.type).toBe('transfer_in');
    expect(outMovement.accountingNature).toBe('internal_transfer');
    expect(inMovement.accountingNature).toBe('internal_transfer');
    expect(outMovement.referenceId).toBe(inMovement.referenceId);
    expect(inMovement.unitCostCents).toBe(1200); // entra al costo transferido

    const from = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    const to = await uow.stockPositions.find(UUID.ORG, UUID.WH2, UUID.PRODUCT);
    expect(from?.quantityOnHand.toFixed()).toBe('6.0000');
    expect(to?.quantityOnHand.toFixed()).toBe('4.0000');
    expect(to?.averageCost.toCents()).toBe(1200);
  });

  it('transferir más de lo que hay lanza InsufficientStockError y no deja nada a medias', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'A' });
    seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'B' });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '2.0000' });

    await expect(
      new TransferStockUseCase(inMemoryGateway(uow)).execute({
        organizationId: UUID.ORG,
        productId: UUID.PRODUCT,
        fromWarehouseId: UUID.WH,
        toWarehouseId: UUID.WH2,
        quantity: '5.0000',
        createdBy: UUID.USER,
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // Ni origen ni destino quedaron tocados, y no hay movimientos.
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'transfer', 'x');
    expect(movements).toHaveLength(0);
    const from = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(from?.quantityOnHand.toFixed()).toBe('2.0000');
    const to = await uow.stockPositions.find(UUID.ORG, UUID.WH2, UUID.PRODUCT);
    expect(to).toBeNull();
  });

  it('falla en medio y hace rollback: el origen queda igual y no hay movimientos huérfanos', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'A' });
    seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'B' });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '10.0000' });

    // La segunda escritura de posición (el destino) explota: el origen ya se
    // guardó. El rollback del snapshot debe restaurarlo.
    const destWarehouseId = UUID.WH2;
    const originalSave = uow.stockPositions.save.bind(uow.stockPositions);
    uow.stockPositions.save = async (pos: StockPosition) => {
      if (pos.warehouseId === destWarehouseId) throw new Error('falla controlada en el destino');
      await originalSave(pos);
    };

    await expect(
      new TransferStockUseCase(inMemoryGateway(uow)).execute({
        organizationId: UUID.ORG,
        productId: UUID.PRODUCT,
        fromWarehouseId: UUID.WH,
        toWarehouseId: UUID.WH2,
        quantity: '4.0000',
        createdBy: UUID.USER,
      }),
    ).rejects.toThrow('falla controlada en el destino');

    const from = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(from?.quantityOnHand.toFixed()).toBe('10.0000');
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'transfer', 'x');
    expect(movements).toHaveLength(0);
    expect(uow.outboxEvents.filter((e) => e.type === 'inventory.stock.transferred')).toHaveLength(0);
  });

  it('origen y destino idénticos lanza SameWarehouseTransferError', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'A' });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });

    await expect(
      new TransferStockUseCase(inMemoryGateway(uow)).execute({
        organizationId: UUID.ORG,
        productId: UUID.PRODUCT,
        fromWarehouseId: UUID.WH,
        toWarehouseId: UUID.WH,
        quantity: '1.0000',
        createdBy: UUID.USER,
      }),
    ).rejects.toBeInstanceOf(SameWarehouseTransferError);
  });
});