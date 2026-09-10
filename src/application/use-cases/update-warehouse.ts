import { Warehouse } from '../../domain/entities.js';
import { MultipleDefaultWarehousesError, WarehouseNotFoundError } from '../../domain/errors.js';
import type { UnitOfWorkGateway } from '../ports.js';

export class UpdateWarehouseUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: {
    organizationId: string;
    warehouseId: string;
    name?: string;
    address?: string | null;
    establishmentId?: string | null;
    isDefault?: boolean;
  }): Promise<Warehouse> {
    const uow = await this.uow.begin();
    try {
      const warehouse = await uow.warehouses.findById(input.warehouseId);
      if (!warehouse || !warehouse.belongsToOrganization(input.organizationId)) {
        throw new WarehouseNotFoundError();
      }

      if (input.isDefault === true && !warehouse.isDefault) {
        const current = await uow.warehouses.findDefault(input.organizationId);
        if (current) {
          current.update({ isDefault: false });
          await uow.warehouses.save(current);
        }
      }
      if (input.isDefault === false && warehouse.isDefault) {
        // Quitarle el flag a la única default dejaría la org sin ninguna.
        throw new MultipleDefaultWarehousesError();
      }

      warehouse.update({
        name: input.name,
        address: input.address,
        establishmentId: input.establishmentId,
        isDefault: input.isDefault,
      });
      await uow.warehouses.save(warehouse);

      await uow.commit();
      return warehouse;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}