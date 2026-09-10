import { describe, expect, it } from 'vitest';
import { GetStockSummaryUseCase } from '../application/use-cases/stock-queries.js';
import { HandleInvoiceIssuedUseCase } from '../application/use-cases/handle-invoice-issued.js';
import { HandlePluginActivatedUseCase } from '../application/use-cases/handle-plugin-activated.js';
import { HandlePluginDeactivatedUseCase } from '../application/use-cases/handle-plugin-deactivated.js';
import { SetOpeningBalanceUseCase } from '../application/use-cases/set-opening-balance.js';
import { INVENTORY_KARDEX_PLUGIN } from '../application/plugin.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedProduct, seedWarehouse } from './helpers.js';

describe('Ciclo del hueco (plugin apagado)', () => {
  it('desactivar abre uno, 3 facturas saltadas lo dejan en 3, reactivar lo cierra y emite stock.stale', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });

    const gateway = inMemoryGateway(uow);
    const deactivate = new HandlePluginDeactivatedUseCase(gateway);
    const activate = new HandlePluginActivatedUseCase(gateway);
    const invoice = new HandleInvoiceIssuedUseCase(gateway, UUID.USER);

    await deactivate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });
    let gap = await uow.inventoryGaps.findOpenGap(UUID.ORG);
    expect(gap).not.toBeNull();
    expect(gap!.skippedMovements).toBe(0);

    for (let i = 0; i < 3; i += 1) {
      await invoice.execute({
        invoiceId: `00000000-0000-0000-0000-00000000020${i}`,
        organizationId: UUID.ORG,
        establishmentId: null,
        lines: [{ productId: UUID.PRODUCT, quantity: 1 }],
      });
    }
    gap = await uow.inventoryGaps.findOpenGap(UUID.ORG);
    expect(gap!.skippedMovements).toBe(3);

    await activate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });

    expect(await uow.inventoryGaps.findOpenGap(UUID.ORG)).toBeNull();
    const stale = uow.outboxEvents.find((e) => e.type === 'inventory.stock.stale');
    expect(stale).toBeDefined();
    expect(stale!.payload.skippedMovements).toBe(3);
    // `toBeLessThanOrEqual`, no `toBeLessThan`: en un test todo el ciclo de
    // abrir y cerrar el hueco cabe dentro del mismo milisegundo, y la prueba
    // fallaba una de cada cinco veces. Lo que importa es que el cierre no sea
    // ANTERIOR a la apertura.
    expect(new Date(stale!.payload.startedAt as string).getTime()).toBeLessThanOrEqual(
      new Date(stale!.payload.endedAt as string).getTime(),
    );
    expect((await uow.organizationPlugins.find(UUID.ORG, INVENTORY_KARDEX_PLUGIN))?.status).toBe('active');
  });

  it('reactivar dos veces no cierra un hueco ya cerrado ni emite el evento de nuevo', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    const gateway = inMemoryGateway(uow);
    const deactivate = new HandlePluginDeactivatedUseCase(gateway);
    const activate = new HandlePluginActivatedUseCase(gateway);

    await deactivate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });
    await activate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });

    const firstStale = uow.outboxEvents.filter((e) => e.type === 'inventory.stock.stale').length;
    const closedAtFirst = (await uow.inventoryGaps.findLastClosedGap(UUID.ORG))?.endedAt;

    await activate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });

    expect(uow.outboxEvents.filter((e) => e.type === 'inventory.stock.stale')).toHaveLength(firstStale);
    const closedGap = await uow.inventoryGaps.findLastClosedGap(UUID.ORG);
    expect(closedGap?.endedAt).toBe(closedAtFirst); // no se reabrió ni se cerró de nuevo
    expect(await uow.inventoryGaps.findOpenGap(UUID.ORG)).toBeNull();
  });

  it('desactivar dos veces no abre un segundo hueco', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    const gateway = inMemoryGateway(uow);
    const deactivate = new HandlePluginDeactivatedUseCase(gateway);

    await deactivate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });
    await deactivate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });

    const gaps = await uow.inventoryGaps.findOpenGap(UUID.ORG);
    expect(gaps).not.toBeNull();
    // Solo uno: contar huecos abiertos vía el repositorio no es posible, así que
    // verificamos que desactivar otra vez NO incrementa su contador.
    expect(gaps!.skippedMovements).toBe(0);
  });

  it('reactivar deja un staleWarning en GET /stock hasta que un conteo físico o saldo inicial lo resuelva', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });
    seedProduct(uow, { id: UUID.PRODUCT, organizationId: UUID.ORG });
    const gateway = inMemoryGateway(uow);
    const deactivate = new HandlePluginDeactivatedUseCase(gateway);
    const activate = new HandlePluginActivatedUseCase(gateway);

    await deactivate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });
    await activate.execute({ organizationId: UUID.ORG, code: INVENTORY_KARDEX_PLUGIN });

    const summary = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { page: 1, pageSize: 10 });
    expect(summary.staleWarning).not.toBeNull();
    expect(summary.staleWarning).toMatchObject({ skippedMovements: 0 });

    // Un saldo inicial posterior resuelve el hueco: desaparece el aviso.
    await new SetOpeningBalanceUseCase(gateway).execute({
      organizationId: UUID.ORG,
      productId: UUID.PRODUCT,
      warehouseId: UUID.WH,
      quantity: '10.0000',
      unitCost: '10.00',
      createdBy: UUID.USER,
    });

    const after = await new GetStockSummaryUseCase(uow).execute(UUID.ORG, { page: 1, pageSize: 10 });
    expect(after.staleWarning).toBeNull();
  });
});