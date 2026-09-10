import { describe, expect, it } from 'vitest';
import { ResolveWarehouseForEstablishmentUseCase } from '../application/use-cases/resolve-warehouse-for-establishment.js';
import { DefaultWarehouseMissingError } from '../domain/errors.js';
import { InMemoryUnitOfWork, UUID, seedWarehouse } from './helpers.js';

describe('Resolución de bodega de la venta', () => {
  it('factura con establecimiento que tiene bodega usa esa', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'SUC', establishmentId: UUID.ESTABLISHMENT, name: 'Sucursal' });
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });

    const resolver = new ResolveWarehouseForEstablishmentUseCase(uow);
    const warehouse = await resolver.execute(UUID.ORG, UUID.ESTABLISHMENT);

    expect(warehouse.id).toBe(UUID.WH2);
  });

  it('sin bodega propia cae en la PRINCIPAL', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });

    const resolver = new ResolveWarehouseForEstablishmentUseCase(uow);
    const warehouse = await resolver.execute(UUID.ORG, UUID.ESTABLISHMENT);

    expect(warehouse.id).toBe(UUID.WH);
  });

  it('sin PRINCIPAL lanza DefaultWarehouseMissingError', async () => {
    const uow = new InMemoryUnitOfWork();
    // Bodega de OTRO establecimiento: no cubre a este y no hay PRINCIPAL.
    seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'SUC', establishmentId: UUID.ESTABLISHMENT2 });

    const resolver = new ResolveWarehouseForEstablishmentUseCase(uow);
    await expect(resolver.execute(UUID.ORG, UUID.ESTABLISHMENT)).rejects.toBeInstanceOf(DefaultWarehouseMissingError);
    await expect(resolver.execute(UUID.ORG, null)).rejects.toBeInstanceOf(DefaultWarehouseMissingError);
  });

  it('bodega de establecimiento inactiva cae en PRINCIPAL', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH2, organizationId: UUID.ORG, code: 'SUC', establishmentId: UUID.ESTABLISHMENT, status: 'inactive' });
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.ORG, code: 'PRINCIPAL', isDefault: true });

    const resolver = new ResolveWarehouseForEstablishmentUseCase(uow);
    const warehouse = await resolver.execute(UUID.ORG, UUID.ESTABLISHMENT);

    expect(warehouse.id).toBe(UUID.WH);
  });

  it('recurso de otra organización no se usa', async () => {
    const uow = new InMemoryUnitOfWork();
    seedWarehouse(uow, { id: UUID.WH, organizationId: UUID.OTHER_ORG, code: 'PRINCIPAL', isDefault: true });

    const resolver = new ResolveWarehouseForEstablishmentUseCase(uow);
    await expect(resolver.execute(UUID.ORG, null)).rejects.toBeInstanceOf(DefaultWarehouseMissingError);
  });
});