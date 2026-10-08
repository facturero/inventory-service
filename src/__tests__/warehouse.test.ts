import { describe, expect, it } from 'vitest';
import { CreateWarehouseUseCase } from '../application/use-cases/create-warehouse.js';
import { DeactivateWarehouseUseCase } from '../application/use-cases/warehouse-queries.js';
import { UpdateWarehouseUseCase } from '../application/use-cases/update-warehouse.js';
import { CannotDeactivateWarehouseWithStockError } from '../domain/errors.js';
import { InMemoryUnitOfWork, UUID, inMemoryGateway, seedPosition, seedWarehouse } from './helpers.js';

describe('Warehouse', () => {
  it('crea la primera bodega como default aunque no lo pidan', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new CreateWarehouseUseCase(inMemoryGateway(uow));

    const w = await useCase.execute({ organizationId: UUID.ORG, code: 'PRINCIPAL', name: 'Bodega Central' });

    expect(w.isDefault).toBe(true);
    expect((await uow.warehouses.findDefault(UUID.ORG))?.id).toBe(w.id);
  });

  it('nunca deja dos bodegas default: la nueva quita el flag a la anterior', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new CreateWarehouseUseCase(inMemoryGateway(uow));

    const first = await useCase.execute({ organizationId: UUID.ORG, code: 'A', name: 'A' });
    const second = await useCase.execute({ organizationId: UUID.ORG, code: 'B', name: 'B', isDefault: true });

    const defaults = (await uow.warehouses.listByOrganization(UUID.ORG)).filter((w) => w.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.id);
    expect((await uow.warehouses.findById(first.id))?.isDefault).toBe(false);
  });

  it('la segunda bodega sin isDefault no toca la default', async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new CreateWarehouseUseCase(inMemoryGateway(uow));

    const first = await useCase.execute({ organizationId: UUID.ORG, code: 'A', name: 'A' });
    const second = await useCase.execute({ organizationId: UUID.ORG, code: 'B', name: 'B' });

    expect(second.isDefault).toBe(false);
    expect((await uow.warehouses.findDefault(UUID.ORG))?.id).toBe(first.id);
  });

  it('deactivate falla cuando la bodega tiene stock > 0', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL' });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '3.0000' });

    const useCase = new DeactivateWarehouseUseCase(inMemoryGateway(uow));
    await expect(useCase.execute({ organizationId: UUID.ORG, warehouseId: UUID.WH })).rejects.toBeInstanceOf(
      CannotDeactivateWarehouseWithStockError,
    );

    expect((await uow.warehouses.findById(UUID.WH))?.status).toBe('active');
  });

  it('deactivate sí procede con posición en cero', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL' });
    seedPosition(uow, { organizationId: UUID.ORG, productId: UUID.PRODUCT, warehouseId: UUID.WH, quantityOnHand: '0.0000' });

    const useCase = new DeactivateWarehouseUseCase(inMemoryGateway(uow));
    await useCase.execute({ organizationId: UUID.ORG, warehouseId: UUID.WH });

    expect((await uow.warehouses.findById(UUID.WH))?.status).toBe('inactive');
  });

  // Antes cambiar o desactivar una bodega no dejaba rastro en la bitácora de auditoría.
  it('update publica inventory.warehouse.updated con lo que había antes', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL' });
    const before = (await uow.warehouses.findById(UUID.WH))!.toPersistence();

    await new UpdateWarehouseUseCase(inMemoryGateway(uow)).execute({
      organizationId: UUID.ORG,
      warehouseId: UUID.WH,
      name: 'Bodega norte',
    });

    const ev = uow.outboxEvents.find((e) => e.type === 'inventory.warehouse.updated');
    expect(ev?.aggregateId).toBe(UUID.WH);
    expect(ev?.payload).toMatchObject({
      warehouseId: UUID.WH,
      organizationId: UUID.ORG,
      name: 'Bodega norte',
      previous: { name: before.name },
    });
  });

  it('update de una bodega ajena no publica nada', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL' });

    await expect(
      new UpdateWarehouseUseCase(inMemoryGateway(uow)).execute({
        organizationId: '99999999-9999-4999-8999-999999999999',
        warehouseId: UUID.WH,
        name: 'x',
      }),
    ).rejects.toThrow();
    expect(uow.outboxEvents).toHaveLength(0);
  });

  it('deactivate publica inventory.warehouse.deactivated, y repetirlo no duplica el aviso', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL' });
    const useCase = new DeactivateWarehouseUseCase(inMemoryGateway(uow));

    await useCase.execute({ organizationId: UUID.ORG, warehouseId: UUID.WH });
    await useCase.execute({ organizationId: UUID.ORG, warehouseId: UUID.WH });

    const eventos = uow.outboxEvents.filter((e) => e.type === 'inventory.warehouse.deactivated');
    expect(eventos).toHaveLength(1);
    expect(eventos[0].payload).toMatchObject({ warehouseId: UUID.WH, organizationId: UUID.ORG });
  });
});