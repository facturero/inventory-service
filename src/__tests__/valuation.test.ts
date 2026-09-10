import { describe, expect, it } from 'vitest';
import { StockLayer, StockPosition } from '../domain/entities.js';
import { FifoStrategy, WeightedAverageStrategy } from '../domain/valuation/strategy.js';
import { Money, Quantity } from '../domain/value-objects.js';
import { applyStockEntry, applyStockExit } from '../application/stock-ops.js';
import { InMemoryUnitOfWork, UUID, seedProduct, seedWarehouse } from './helpers.js';

function positionWithCents(avgCents: number): StockPosition {
  return StockPosition.fromPersistence({
    id: '00000000-0000-0000-0000-000000000001',
    organizationId: '00000000-0000-0000-0000-000000000010',
    productId: '00000000-0000-0000-0000-000000000020',
    warehouseId: '00000000-0000-0000-0000-000000000030',
    quantityOnHand: '0.0000',
    quantityReserved: '0.0000',
    quantityAvailable: '0.0000',
    averageCostCents: avgCents,
    currencyCode: 'USD',
    updatedAt: new Date(),
  });
}

function layer(quantity: string, unitCostCents: number, enteredAt: Date): StockLayer {
  return StockLayer.fromPersistence({
    id: `layer-${unitCostCents}-${quantity}`,
    organizationId: '00000000-0000-0000-0000-000000000010',
    productId: '00000000-0000-0000-0000-000000000020',
    warehouseId: '00000000-0000-0000-0000-000000000030',
    entryMovementId: '00000000-0000-0000-0000-000000000099',
    quantityRemaining: Quantity.fromString(quantity),
    unitCostCents,
    currencyCode: 'USD',
    enteredAt,
    lotId: null,
  });
}

describe('WeightedAverageStrategy', () => {
  it('100 a $10 + 100 a $12 = promedio $11', () => {
    const strategy = new WeightedAverageStrategy();
    const pos = positionWithCents(0);

    const first = pos.applyEntry({ quantity: Quantity.fromNumber(100), unitCost: Money.fromCents(1000, 'USD'), method: 'weighted_average' });
    expect(first.averageCost.toCents()).toBe(1000);

    const second = pos.applyEntry({ quantity: Quantity.fromNumber(100), unitCost: Money.fromCents(1200, 'USD'), method: 'weighted_average' });
    expect(second.averageCost.toCents()).toBe(1100);
    expect(pos.quantityOnHand.toFixed()).toBe('200.0000');
  });

  it('la salida sale al promedio y el total es qty * promedio', () => {
    const strategy = new WeightedAverageStrategy();
    const pos = positionWithCents(1200);

    const cogs = pos.applyExit({ quantity: Quantity.fromNumber(10), valuationStrategy: strategy, layers: [] });

    expect(cogs.totalCostCents).toBe(12000);
    expect(cogs.unitCostCents).toBe(1200);
  });

  it('strategy.onExit con estado vacío (0 unidades) no pierde precisión decimal', () => {
    const strategy = new WeightedAverageStrategy();
    const pos = StockPosition.fromPersistence({
      id: 'x', organizationId: 'o', productId: 'p', warehouseId: 'w',
      quantityOnHand: '0.3000', quantityReserved: '0.0000', quantityAvailable: '0.3000',
      averageCostCents: 1000, currencyCode: 'USD', updatedAt: new Date(),
    });
    const cogs = pos.applyExit({ quantity: Quantity.fromNumber(0.3), valuationStrategy: strategy, layers: [] });
    expect(cogs.totalCostCents).toBe(300);
  });
});

describe('FifoStrategy', () => {
  it('consume las capas en orden de entrada', () => {
    const strategy = new FifoStrategy();
    const pos = positionWithCents(1000);
    const layers = [layer('10.0000', 1000, new Date(2026, 0, 1)), layer('20.0000', 1200, new Date(2026, 0, 2))];

    const cogs = pos.applyExit({ quantity: Quantity.fromNumber(15), valuationStrategy: strategy, layers });

    // Capa 1 entera (10×$10) + 5 de la capa 2 (5×$12) = 100 + 60 = 160.
    expect(cogs.totalCostCents).toBe(16000);
    expect(cogs.consumedLayers).toHaveLength(2);
    expect(cogs.uncoveredQuantity.toFixed()).toBe('0.0000');
    // La estrategia es pura: reporta qué capas consumir y cuánto de cada una,
    // pero NO las modifica. Quien decrementa y persiste es applyStockExit
    // (ver el test "FIFO por la vía de aplicación" más abajo).
    expect(cogs.consumedLayers[0].quantity.toFixed()).toBe('10.0000');
    expect(cogs.consumedLayers[1].quantity.toFixed()).toBe('5.0000');
    expect(layers[0].quantityRemaining.toFixed()).toBe('10.0000');
    expect(layers[1].quantityRemaining.toFixed()).toBe('20.0000');
  });

  it('consumo parcial de una sola capa', () => {
    const strategy = new FifoStrategy();
    const pos = positionWithCents(1200);
    const layers = [layer('10.0000', 1200, new Date(2026, 0, 1))];

    const cogs = pos.applyExit({ quantity: Quantity.fromNumber(4), valuationStrategy: strategy, layers });

    expect(cogs.totalCostCents).toBe(4800);
    expect(cogs.consumedLayers).toHaveLength(1);
    expect(cogs.consumedLayers[0].quantity.toFixed()).toBe('4.0000');
    expect(cogs.uncoveredQuantity.toFixed()).toBe('0.0000');
    expect(layers[0].quantityRemaining.toFixed()).toBe('10.0000'); // la estrategia no muta
  });

  it('una entrada FIFO pide crear capa nueva', () => {
    const strategy = new FifoStrategy();
    const pos = positionWithCents(0);

    const update = pos.applyEntry({ quantity: Quantity.fromNumber(25), unitCost: Money.fromCents(900, 'USD'), method: 'fifo' });

    expect(update.layer).toBeDefined();
    expect(update.layer!.quantityRemaining.toFixed()).toBe('25.0000');
    expect(update.layer!.unitCost.toCents()).toBe(900);
  });
});

describe('FIFO por la vía de aplicación', () => {
  it('decrementa y persiste las capas consumidas, y no vuelve a consumirlas', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    const product = seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG, valuationMethod: 'fifo' });

    const entry = (qty: string, cents: number) =>
      applyStockEntry(uow, {
        organizationId: UUID.ORG,
        warehouseId: UUID.WH,
        product,
        quantity: Quantity.fromString(qty),
        unitCost: Money.fromCents(cents, 'USD'),
        type: 'purchase_in',
        accountingNature: 'inventory_in',
        referenceType: null,
        referenceId: null,
        createdBy: UUID.USER,
      });

    await entry('10.0000', 1000); // capa 1: 10 a $10
    await entry('20.0000', 1200); // capa 2: 20 a $12

    const exit = await applyStockExit(uow, {
      organizationId: UUID.ORG,
      warehouseId: UUID.WH,
      product,
      quantity: Quantity.fromNumber(15),
      type: 'sale_out',
      accountingNature: 'cogs',
      referenceType: 'invoice',
      referenceId: UUID.PRODUCT2,
      createdBy: UUID.USER,
      checkStock: false,
    });

    // 10 a $10 + 5 a $12 = $160.
    expect(exit.movement.totalCostCents).toBe(16000);

    // La capa 1 quedó agotada y ya no aparece entre las activas; la 2 conserva 15.
    const active = await uow.stockLayers.findActiveLayers(UUID.ORG, UUID.PRODUCT, UUID.WH);
    expect(active).toHaveLength(1);
    expect(active[0].quantityRemaining.toFixed()).toBe('15.0000');

    // Una segunda salida NO puede volver a comerse la capa 1: sale toda a $12.
    const exit2 = await applyStockExit(uow, {
      organizationId: UUID.ORG,
      warehouseId: UUID.WH,
      product,
      quantity: Quantity.fromNumber(5),
      type: 'sale_out',
      accountingNature: 'cogs',
      referenceType: 'invoice',
      referenceId: UUID.PRODUCT2,
      createdBy: UUID.USER,
      checkStock: false,
    });
    expect(exit2.movement.totalCostCents).toBe(6000);
  });
});
