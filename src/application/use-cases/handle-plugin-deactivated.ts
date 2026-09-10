import { InventoryGap, OrganizationPlugin } from '../../domain/entities.js';
import { INVENTORY_KARDEX_PLUGIN } from '../plugin.js';
import type { UnitOfWorkGateway } from '../ports.js';

/** Desactiva el seguimiento de stock: marca disabled y abre un hueco si no
 *  había uno abierto. NO borra nada: el kardex histórico se conserva intacto,
 *  simplemente deja de crecer. */
export class HandlePluginDeactivatedUseCase {
  constructor(private readonly uow: UnitOfWorkGateway) {}

  async execute(payload: { organizationId: string; code: string }): Promise<void> {
    if (payload.code !== INVENTORY_KARDEX_PLUGIN) return;

    const uow = await this.uow.begin();
    try {
      const plugin = await uow.organizationPlugins.find(payload.organizationId, INVENTORY_KARDEX_PLUGIN);
      if (plugin && !plugin.isActive()) {
        await uow.commit();
        return;
      }
      if (plugin) {
        plugin.deactivate();
        await uow.organizationPlugins.save(plugin);
      } else {
        const fresh = OrganizationPlugin.create({ organizationId: payload.organizationId, pluginCode: INVENTORY_KARDEX_PLUGIN, status: 'disabled' });
        await uow.organizationPlugins.save(fresh);
      }

      const gap = await uow.inventoryGaps.findOpenGap(payload.organizationId);
      if (!gap) {
        const open = InventoryGap.create({ organizationId: payload.organizationId, startedAt: new Date() });
        await uow.inventoryGaps.save(open);
      }

      await uow.commit();
    } catch (err) {
      await uow.rollback();
      throw err;
    }
  }
}