import { describe, expect, it } from 'vitest';
import { AdjustStockUseCase } from '../application/use-cases/adjust-stock.js';
import { RegisterPurchaseEntryUseCase } from '../application/use-cases/register-purchase-entry.js';
import { TransferStockUseCase } from '../application/use-cases/transfer-stock.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedPosition, seedProduct, seedWarehouse } from './helpers.js';

/**
 * Ancho de `outbox_messages.aggregate_type` tras la migración 20261019100000-widen-outbox-aggregate-type.cjs.
 * Antes medía 50 y los eventos de stock usan `${productId}:${warehouseId}` (73; 110 las transferencias): con MySQL estricto el
 * INSERT del outbox fallaba y se revertía TODO movimiento de stock. Los repos en memoria no tienen ancho de columna, así que
 * ninguna prueba lo había visto. Si alguien acorta la columna o alarga el valor, falla aquí.
 */
const OUTBOX_AGGREGATE_TYPE_WIDTH = 150;

function setup() {
  const uow = new InMemoryUnitOfWork();
  seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'A', isDefault: true });
  seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'B' });
  seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
  return uow;
}

const widest = (uow: InMemoryUnitOfWork) => Math.max(...uow.outboxEvents.map((e) => e.aggregateType.length));

describe('outbox: el aggregate_type de los eventos de stock cabe en su columna', () => {
  it('entrada y salida por ajuste', async () => {
    const uow = setup();
    const adjust = new AdjustStockUseCase(inMemoryGateway(uow));
    await adjust.execute({ organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantity: '10.0000', reasonCode: 'physical_count', unitCost: '2.50', createdBy: UUID.USER });
    await adjust.execute({ organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantity: '-3.0000', reasonCode: 'damage', createdBy: UUID.USER });
    expect(uow.outboxEvents.length).toBeGreaterThanOrEqual(2);
    expect(widest(uow)).toBeLessThanOrEqual(OUTBOX_AGGREGATE_TYPE_WIDTH);
    expect(widest(uow)).toBeGreaterThan(50); // el caso que rompía: pasa de los 50 de antes
  });

  it('transferencia entre bodegas (el valor más largo: producto:origen:destino)', async () => {
    const uow = setup();
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '10.0000', averageCostCents: 1200 });
    await new TransferStockUseCase(inMemoryGateway(uow)).execute({ organizationId: UUID.ORG, productId: UUID.PRODUCT, fromWarehouseId: UUID.WH, toWarehouseId: UUID.WH2, quantity: '4.0000', createdBy: UUID.USER });
    expect(widest(uow)).toBeLessThanOrEqual(OUTBOX_AGGREGATE_TYPE_WIDTH);
    expect(widest(uow)).toBeGreaterThan(100);
  });
});

describe('entrada de stock por recepción de compra (purchase.purchase_order.received)', () => {
  const run = (uow: InMemoryUnitOfWork, extra: Record<string, unknown> = {}, qty = '10') =>
    new RegisterPurchaseEntryUseCase(inMemoryGateway(uow), UUID.USER).execute({
      purchaseOrderId: '99999999-9999-9999-9999-999999999999',
      organizationId: UUID.ORG,
      warehouseId: UUID.WH,
      lines: [{ productId: UUID.PRODUCT, quantity: qty, unitCostCents: 250, currencyCode: 'USD' }],
      ...extra,
    });

  it('con receiptId el movimiento referencia la recepción', async () => {
    const uow = setup();
    await run(uow, { receiptId: '88888888-8888-8888-8888-888888888888', receiptNumber: 'RM-2026-000001' });
    const [m] = await uow.stockMovements.listByProduct(UUID.ORG, UUID.PRODUCT, UUID.WH, 10);
    expect(m.type).toBe('purchase_in');
    expect(m.referenceType).toBe('goods_receipt');
    expect(m.referenceId).toBe('88888888-8888-8888-8888-888888888888');
    expect(m.accountingNature).toBe('inventory_in');
  });

  it('sin receiptId se comporta como antes (referencia la orden): compatibilidad hacia atrás', async () => {
    const uow = setup();
    await run(uow);
    const [m] = await uow.stockMovements.listByProduct(UUID.ORG, UUID.PRODUCT, UUID.WH, 10);
    expect(m.referenceType).toBe('purchase_order');
    expect(m.referenceId).toBe('99999999-9999-9999-9999-999999999999');
  });

  it('recepciones parciales suman exactamente lo recibido, a su costo', async () => {
    const uow = setup();
    await run(uow, { receiptId: '88888888-8888-8888-8888-888888888881' }, '10');
    await run(uow, { receiptId: '88888888-8888-8888-8888-888888888882' }, '20.5');
    const pos = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos?.quantityOnHand.toFixed()).toBe('30.5000');
    expect(pos?.averageCost.toCents()).toBe(250);
  });

  it('un producto que no lleva stock no rompe la recepción ni mueve nada', async () => {
    const uow = setup();
    const created = await new RegisterPurchaseEntryUseCase(inMemoryGateway(uow), UUID.USER).execute({
      purchaseOrderId: '99999999-9999-9999-9999-999999999999',
      organizationId: UUID.ORG,
      warehouseId: UUID.WH,
      lines: [{ productId: UUID.PRODUCT2, quantity: '5', unitCostCents: 100, currencyCode: 'USD' }],
    });
    expect(created).toBe(0);
  });
});
