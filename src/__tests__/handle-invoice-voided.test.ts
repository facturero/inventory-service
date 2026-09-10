import { describe, expect, it } from 'vitest';
import { HandleInvoiceVoidedUseCase } from '../application/use-cases/handle-invoice-voided.js';
import { StockMovement } from '../domain/entities.js';
import { applyStockEntry } from '../application/stock-ops.js';
import { Money, Quantity } from '../domain/value-objects.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedProduct, seedWarehouse } from './helpers.js';

const INVOICE_ID = '00000000-0000-0000-0000-000000000300';

function seedSaleOut(uow: InMemoryUnitOfWork, unitCostCents: number, quantity: Quantity) {
  const movement = StockMovement.create({
    organizationId: UUID.ORG,
    productId: UUID.PRODUCT,
    warehouseId: UUID.WH,
    type: 'sale_out',
    quantity,
    unitCostCents,
    totalCostCents: quantity.toNumber() * unitCostCents,
    currencyCode: 'USD',
    referenceType: 'invoice',
    referenceId: INVOICE_ID,
    accountingNature: 'cogs',
    reasonCode: null,
    lotId: null,
    notes: null,
    createdBy: UUID.USER,
  });
  void uow.stockMovements.save(movement);
  return movement;
}

describe('HandleInvoiceVoided', () => {
  it('repone al costo ORIGINAL aunque el promedio haya cambiado después', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    const gateway = inMemoryGateway(uow);

    // Simula el kardex histórico: salió 10 a $10, luego llegó mucho más caro.
    seedSaleOut(uow, 1000, Quantity.fromNumber(10));
    await applyStockEntry(uow, {
      organizationId: UUID.ORG,
      warehouseId: UUID.WH,
      product: (await uow.products.findById(UUID.ORG, UUID.PRODUCT))!,
      quantity: Quantity.fromNumber(100),
      unitCost: Money.fromCents(2000, 'USD'),
      type: 'purchase_in',
      accountingNature: 'inventory_in',
      referenceType: 'purchase',
      referenceId: null,
      notes: null,
      createdBy: UUID.USER,
    });

    const restored = await new HandleInvoiceVoidedUseCase(gateway, UUID.USER).execute({
      invoiceId: INVOICE_ID,
      organizationId: UUID.ORG,
    });

    expect(restored).toBe(1);
    const adjustments = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', INVOICE_ID, 'adjustment_in');
    expect(adjustments).toHaveLength(1);
    // $10.00 original, NO el $20.00 del promedio vigente.
    expect(adjustments[0].unitCostCents).toBe(1000);
    expect(adjustments[0].totalCostCents).toBe(10000);
    expect(adjustments[0].accountingNature).toBe('inventory_in');

    const pos = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos).not.toBeNull();
  });

  it('con FIFO crea un layer NUEVO al costo original (no resucita el consumido)', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG, valuationMethod: 'fifo' });
    const gateway = inMemoryGateway(uow);

    seedSaleOut(uow, 1000, Quantity.fromNumber(10));

    const restored = await new HandleInvoiceVoidedUseCase(gateway, UUID.USER).execute({
      invoiceId: INVOICE_ID,
      organizationId: UUID.ORG,
    });

    expect(restored).toBe(1);
    const layers = await uow.stockLayers.findActiveLayers(UUID.ORG, UUID.PRODUCT, UUID.WH);
    expect(layers).toHaveLength(1);
    expect(layers[0].unitCostCents).toBe(1000);
    expect(layers[0].quantityRemaining.toFixed()).toBe('10.0000');

    const adjustments = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', INVOICE_ID, 'adjustment_in');
    expect(adjustments[0].id).toBe(layers[0].entryMovementId);
  });

  it('sin sale_out de la factura no repone nada', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });

    const restored = await new HandleInvoiceVoidedUseCase(inMemoryGateway(uow), UUID.USER).execute({
      invoiceId: INVOICE_ID,
      organizationId: UUID.ORG,
    });

    expect(restored).toBe(0);
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', INVOICE_ID);
    expect(movements).toHaveLength(0);
  });
});