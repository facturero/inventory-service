import { Warehouse } from '../../domain/entities.js';
import { WarehouseCodeExistsError } from '../../domain/errors.js';
import { warehouseCreatedEvent } from '../events.js';
import type { UnitOfWorkGateway } from '../ports.js';

export class CreateWarehouseUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(input: {
    organizationId: string;
    code: string;
    name: string;
    address?: string | null;
    establishmentId?: string | null;
    isDefault?: boolean;
  }): Promise<Warehouse> {
    const uow = await this.uow.begin();
    try {
      if (await uow.warehouses.existsByCode(input.organizationId, input.code)) {
        throw new WarehouseCodeExistsError();
      }

      const count = await uow.warehouses.countByOrganization(input.organizationId);
      // Invariante: exactamente una bodega default por organización. La primera
      // bodega de una org SIEMPRE es default; el resto, solo si lo piden.
      const isDefault = input.isDefault ?? false;

      if (isDefault) {
        const current = await uow.warehouses.findDefault(input.organizationId);
        if (current) {
          current.update({ isDefault: false });
          await uow.warehouses.save(current);
        }
      }

      const warehouse = Warehouse.create({
        organizationId: input.organizationId,
        code: input.code,
        name: input.name,
        address: input.address ?? null,
        establishmentId: input.establishmentId ?? null,
        isDefault: count === 0 ? true : isDefault,
      });
      await uow.warehouses.save(warehouse);

      await uow.outbox.add(warehouseCreatedEvent(warehouse));
      await uow.commit();
      return warehouse;
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}