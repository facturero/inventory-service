import { describe, expect, it } from 'vitest';
import { AdjustStockUseCase } from '../application/use-cases/adjust-stock.js';
import { GetStockMovementsUseCase, GetStockSummaryUseCase } from '../application/use-cases/stock-queries.js';
import { InvalidAdjustmentReasonError, ProductNotTrackedError, ValidationError } from '../domain/errors.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedProduct, seedWarehouse } from './helpers.js';

function setup() {
  const uow = new InMemoryUnitOfWork();
  seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
  seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
  return uow;
}

function adjust(uow: InMemoryUnitOfWork) {
  const useCase = new AdjustStockUseCase(inMemoryGateway(uow));
  return (quantity: string, reasonCode: string, unitCost?: string) =>
    useCase.execute({
      organizationId: UUID.ORG,
      productId: UUID.PRODUCT,
      warehouseId: UUID.WH,
      quantity,
      reasonCode,
      ...(unitCost ? { unitCost } : {}),
      createdBy: UUID.USER,
    });
}

/**
 * El motivo tipificado es lo que decide la cuenta contable del movimiento. Es
 * la pieza sobre la que se apoyará el generador de asientos cuando exista el
 * libro mayor, así que la tabla de motivo + signo se prueba entera: si alguien
 * la toca, esto tiene que romperse.
 */
describe('AdjustStock — motivo tipificado y naturaleza contable', () => {
  it('salida por consumo interno es gasto, no merma', async () => {
    const uow = setup();
    const run = adjust(uow);

    await run('100.0000', 'physical_count', '10.00');
    const movement = await run('-5.0000', 'internal_use');

    expect(movement.type).toBe('adjustment_out');
    expect(movement.accountingNature).toBe('expense');
    expect(movement.reasonCode).toBe('internal_use');
  });

  it.each([
    ['damage', 'shrinkage'],
    ['expiration', 'shrinkage'],
    ['theft', 'shrinkage'],
    ['physical_count', 'shrinkage'],
    ['correction', 'shrinkage'],
  ])('salida por %s es %s', async (reasonCode, expected) => {
    const uow = setup();
    const run = adjust(uow);

    await run('100.0000', 'physical_count', '10.00');
    const movement = await run('-1.0000', reasonCode);

    expect(movement.accountingNature).toBe(expected);
  });

  it.each([
    ['physical_count', 'inventory_gain'],
    ['correction', 'inventory_gain'],
  ])('entrada por %s es %s', async (reasonCode, expected) => {
    const uow = setup();
    const movement = await adjust(uow)('7.0000', reasonCode);

    expect(movement.type).toBe('adjustment_in');
    expect(movement.accountingNature).toBe(expected);
  });

  it('un motivo que no está en la tabla no se escribe', async () => {
    const uow = setup();
    await expect(adjust(uow)('1.0000', 'porque_si')).rejects.toBeInstanceOf(InvalidAdjustmentReasonError);
  });

  it('cantidad cero se rechaza: no existe el ajuste que no ajusta nada', async () => {
    const uow = setup();
    await expect(adjust(uow)('0.0000', 'physical_count')).rejects.toBeInstanceOf(ValidationError);
  });

  it('un producto sin seguimiento de existencias no admite ajuste', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG, trackStock: false });

    await expect(adjust(uow)('1.0000', 'physical_count')).rejects.toBeInstanceOf(ProductNotTrackedError);
  });
});

describe('AdjustStock — costo', () => {
  it('dos entradas escalonadas dejan el promedio en el punto medio ponderado', async () => {
    const uow = setup();
    const run = adjust(uow);

    await run('100.0000', 'physical_count', '10.00');
    await run('100.0000', 'physical_count', '12.00');

    const summary = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { productId: UUID.PRODUCT });
    expect(summary.data[0].averageCostCents).toBe(1100);
  });

  it('un sobrante de conteo sin costo entra al promedio vigente, no a cero', async () => {
    const uow = setup();
    const run = adjust(uow);

    await run('10.0000', 'physical_count', '20.00');
    // Sin unitCost: no hay factura detrás de un sobrante de conteo.
    const movement = await run('5.0000', 'physical_count');

    expect(movement.unitCostCents).toBe(2000);
    const summary = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { productId: UUID.PRODUCT });
    expect(summary.data[0].averageCostCents).toBe(2000);
  });

  it('sobre una posición en cero, un sobrante sin costo entra a cero', async () => {
    const uow = setup();
    const movement = await adjust(uow)('5.0000', 'physical_count');

    expect(movement.unitCostCents).toBe(0);
  });
});

describe('Consultas de stock', () => {
  it('el resumen devuelve la posición con su bodega, disponible y promedio', async () => {
    const uow = setup();
    await adjust(uow)('40.0000', 'physical_count', '2.50');

    const summary = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { page: 1, pageSize: 10 });

    expect(summary.total).toBe(1);
    expect(summary.data[0]).toMatchObject({
      productId: UUID.PRODUCT,
      warehouseCode: 'PRINCIPAL',
      quantityOnHand: '40.0000',
      quantityAvailable: '40.0000',
      averageCostCents: 250,
    });
    expect(summary.staleWarning).toBeNull();
  });

  it('el filtro de existencia separa lo que hay de lo que se agotó', async () => {
    const uow = setup();
    const run = adjust(uow);
    await run('10.0000', 'physical_count', '1.00');
    await run('-10.0000', 'physical_count');

    const withStock = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { stockState: 'with_stock' });
    const withoutStock = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { stockState: 'without_stock' });

    // La posición quedó exactamente en cero: cuenta como "sin existencia".
    expect(withStock.data).toHaveLength(0);
    expect(withoutStock.data).toHaveLength(1);
  });

  it('el kardex devuelve los movimientos del producto con su naturaleza', async () => {
    const uow = setup();
    const run = adjust(uow);
    await run('10.0000', 'physical_count', '1.00');
    await run('-2.0000', 'damage');

    const page = await new GetStockMovementsUseCase(uow).execute(UUID.ORG, { productId: UUID.PRODUCT });

    expect(page.total).toBe(2);
    expect(page.data.map((m) => m.accountingNature).sort()).toEqual(['inventory_gain', 'shrinkage']);
  });
});
