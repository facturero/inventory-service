import { Warehouse } from '../../domain/entities.js';
import { CannotDeactivateWarehouseWithStockError, WarehouseNotFoundError } from '../../domain/errors.js';
import type { UnitOfWorkGateway } from '../ports.js';

export class ListWarehousesUseCase {
  constructor(private readonly repos: { warehouses: { listByOrganization(organizationId: string): Promise<Warehouse[]> } }) {}

  async execute(organizationId: string): Promise<Warehouse[]> {
    return this.repos.warehouses.listByOrganization(organizationId);
  }
}

export class GetWarehouseUseCase {
  constructor(private readonly repos: { warehouses: { findById(id: string): Promise<Warehouse | null> } }) {}

  async execute(organizationId: string, warehouseId: string): Promise<Warehouse> {
    const warehouse = await this.repos.warehouses.findById(warehouseId);
    if (!warehouse || !warehouse.belongsToOrganization(organizationId)) {
      throw new WarehouseNotFoundError();
    }
    return warehouse;
  }
}

export class DeactivateWarehouseUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: { organizationId: string; warehouseId: string }): Promise<void> {
    const uow = await this.uow.begin();
    try {
      const warehouse = await uow.warehouses.findById(input.warehouseId);
      if (!warehouse || !warehouse.belongsToOrganization(input.organizationId)) {
        throw new WarehouseNotFoundError();
      }
      if (warehouse.status === 'inactive') {
        await uow.commit();
        return;
      }

      // No se desactiva una bodega con stock: el inventario que guarda no se
      // puede quedar huérfano de consultas.
      const positions = await uow.stockPositions.findByWarehouse(input.organizationId, input.warehouseId);
      if (positions.some((p) => p.quantityOnHand.isPositive())) {
        throw new CannotDeactivateWarehouseWithStockError();
      }

      warehouse.deactivate();
      await uow.warehouses.save(warehouse);
      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}