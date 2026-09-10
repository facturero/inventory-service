import { describe, expect, it } from 'vitest';
import { HandleInvoiceIssuedUseCase } from '../application/use-cases/handle-invoice-issued.js';
import { INVENTORY_KARDEX_PLUGIN } from '../application/plugin.js';
import { OrganizationPlugin } from '../domain/entities.js';
import { Quantity } from '../domain/value-objects.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedPosition, seedProduct, seedWarehouse } from './helpers.js';

function issuedUseCase(uow: InMemoryUnitOfWork) {
  return new HandleInvoiceIssuedUseCase(inMemoryGateway(uow), UUID.USER);
}

describe('HandleInvoiceIssued', () => {
  it('descuenta directo por línea con accounting_nature cogs', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedProduct(uow, { id: UUID.PRODUCT2, organizationId: UUID.ORG });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '10.0000' });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT2, warehouseId: UUID.WH, quantityOnHand: '10.0000' });

    const { writtenLines } = await issuedUseCase(uow).execute({
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [
        { productId: UUID.PRODUCT, quantity: 2 },
        { productId: UUID.PRODUCT2, quantity: 5 },
      ],
    });

    expect(writtenLines).toBe(2);
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', '00000000-0000-0000-0000-000000000101', 'sale_out');
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.accountingNature === 'cogs')).toBe(true);
    expect(movements.map((m) => m.quantity.toFixed()).sort()).toEqual(['2.0000', '5.0000']);

    const pos1 = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos1?.quantityOnHand.toFixed()).toBe('8.0000');
    const pos2 = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT2);
    expect(pos2?.quantityOnHand.toFixed()).toBe('5.0000');
  });

  it('reprocesar la misma factura no duplica movimientos', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '10.0000' });

    const useCase = issuedUseCase(uow);
    const payload = {
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 2 }],
    };

    const first = await useCase.execute(payload);
    const second = await useCase.execute(payload);

    expect(first.writtenLines).toBe(1);
    expect(second.writtenLines).toBe(0);
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', '00000000-0000-0000-0000-000000000101', 'sale_out');
    expect(movements).toHaveLength(1);
    const pos = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos?.quantityOnHand.toFixed()).toBe('8.0000');
  });

  it('producto sin trackStock no genera movimiento (línea saltada)', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    // Servicio (nunca lleva stock) — la línea se ignora.
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG, trackStock: false, type: 'service' });

    const { writtenLines, skippedLines } = await issuedUseCase(uow).execute({
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 1 }],
    });

    expect(writtenLines).toBe(0);
    expect(skippedLines).toBe(0);
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', '00000000-0000-0000-0000-000000000101', 'sale_out');
    expect(movements).toHaveLength(0);
  });

  it('sin stock suficiente el movimiento se escribe igual, la posición queda negativa y se emite la alerta', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG, allowNegativeStock: false });

    const { writtenLines } = await issuedUseCase(uow).execute({
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 5 }],
    });

    expect(writtenLines).toBe(1);
    const pos = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos?.quantityOnHand.toFixed()).toBe('-5.0000');

    const negative = uow.outboxEvents.find((e) => e.type === 'inventory.stock.negative');
    expect(negative).toBeDefined();
    expect(negative!.payload.allowNegativeStock).toBe(false);
    expect(negative!.payload.currentOnHand).toBe('-5.0000');
  });

  it('con allow_negative_stock=true el kardex es igual; solo cambia que la alerta se marca como esperada', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG, allowNegativeStock: true });

    await issuedUseCase(uow).execute({
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 3 }],
    });

    const pos = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos?.quantityOnHand.toFixed()).toBe('-3.0000');

    const negative = uow.outboxEvents.find((e) => e.type === 'inventory.stock.negative');
    expect(negative).toBeDefined();
    expect(negative!.payload.allowNegativeStock).toBe(true);
  });

  it('cantidad que llega como float: 0.1 + 0.2 deja exactamente 0.3 descontado', async () => {
    expect(Quantity.fromNumber(0.1).add(Quantity.fromNumber(0.2)).toFixed()).toBe('0.3000');

    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '10.0000' });

    const useCase = issuedUseCase(uow);
    await useCase.execute({
      invoiceId: '11111111-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 0.1 }],
    });
    await useCase.execute({
      invoiceId: '11111111-0000-0000-0000-000000000102',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 0.2 }],
    });

    const pos = await uow.stockPositions.find(UUID.ORG, UUID.WH, UUID.PRODUCT);
    expect(pos?.quantityOnHand.toFixed()).toBe('9.7000');
    // 9.7 exacto: si la resta hubiera ido por float crudo daría 9.699999999999999.
    expect(pos!.quantityOnHand.isZero()).toBe(false);
  });

  it('con el plugin apagado NO escribe movimientos, anota el hueco y confirma', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    seedProduct(uow, { id: UUID.PRODUCT2, organizationId: UUID.ORG });
    await uow.organizationPlugins.save(
      OrganizationPlugin.create({ organizationId: UUID.ORG, pluginCode: INVENTORY_KARDEX_PLUGIN, status: 'disabled' }),
    );

    const { writtenLines, skippedLines } = await issuedUseCase(uow).execute({
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [
        { productId: UUID.PRODUCT, quantity: 2 },
        { productId: UUID.PRODUCT2, quantity: 5 },
      ],
    });

    expect(writtenLines).toBe(0);
    expect(skippedLines).toBe(2);
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', '00000000-0000-0000-0000-000000000101', 'sale_out');
    expect(movements).toHaveLength(0);
    const gap = await uow.inventoryGaps.findOpenGap(UUID.ORG);
    expect(gap).not.toBeNull();
    expect(gap!.skippedMovements).toBe(2);
  });

  it('plugin sin fila y catálogo caído: el movimiento SÍ se escribe (ante duda, procesa)', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    // Sin fila en organization_plugins y sin cold-start configurado: el
    // read-model devuelve activo (procesar) en vez de bloquear la venta.
    const local = uow;
    expect(await local.organizationPlugins.getActivationState(UUID.ORG, INVENTORY_KARDEX_PLUGIN)).toBe(true);

    const { writtenLines } = await issuedUseCase(uow).execute({
      invoiceId: '00000000-0000-0000-0000-000000000101',
      organizationId: UUID.ORG,
      establishmentId: null,
      lines: [{ productId: UUID.PRODUCT, quantity: 1 }],
    });

    expect(writtenLines).toBe(1);
    const movements = await uow.stockMovements.listByReference(UUID.ORG, 'invoice', '00000000-0000-0000-0000-000000000101', 'sale_out');
    expect(movements).toHaveLength(1);
  });
});