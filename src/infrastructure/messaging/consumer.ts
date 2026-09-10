import { EventHandler, InboxConsumer } from '@facturero/outbox-relay';
import type { Sequelize } from 'sequelize';
import { EnsureDefaultWarehouseUseCase, EnsureWarehouseForEstablishmentUseCase } from '../../application/use-cases/ensure-warehouse-for-establishment.js';
import { HandleInvoiceIssuedUseCase } from '../../application/use-cases/handle-invoice-issued.js';
import { HandleInvoiceVoidedUseCase } from '../../application/use-cases/handle-invoice-voided.js';
import { HandlePluginActivatedUseCase } from '../../application/use-cases/handle-plugin-activated.js';
import { HandlePluginDeactivatedUseCase } from '../../application/use-cases/handle-plugin-deactivated.js';
import { RefreshProductReadModelUseCase } from '../../application/use-cases/refresh-product-read-model.js';
import { RegisterPurchaseEntryUseCase } from '../../application/use-cases/register-purchase-entry.js';
import type { UnitOfWorkGateway } from '../../application/ports.js';
import type { UnitOfWork } from '../../domain/repositories.js';

/** Eventos que consume inventory-service (ver asyncapi.yaml). Todo pasa por el
 *  InboxConsumer: idempotencia, reintentos y el estado `failed` viven en
 *  processed_events. */
export const CONSUMED_BINDINGS = [
  'plugin.activated',
  'plugin.deactivated',
  'organization.org.updated',
  'organization.establishment.created',
  'product.product.created',
  'product.product.updated',
  'product.product.disabled',
  'billing.invoice.issued',
  'billing.invoice.voided',
  'purchase.purchase_order.received',
] as const;

export interface ConsumerDeps {
  uowGateway: UnitOfWorkGateway;
  systemUserId: string;
  productRepo: Pick<UnitOfWork, 'products'>;
}

export function buildEventHandlers(deps: ConsumerDeps): EventHandler[] {
  const refreshProduct = new RefreshProductReadModelUseCase(deps.productRepo);
  const invoiceIssued = new HandleInvoiceIssuedUseCase(deps.uowGateway, deps.systemUserId);
  const invoiceVoided = new HandleInvoiceVoidedUseCase(deps.uowGateway, deps.systemUserId);
  const pluginActivated = new HandlePluginActivatedUseCase(deps.uowGateway);
  const pluginDeactivated = new HandlePluginDeactivatedUseCase(deps.uowGateway);
  const ensureEstablishment = new EnsureWarehouseForEstablishmentUseCase(deps.uowGateway);
  const ensureDefault = new EnsureDefaultWarehouseUseCase(deps.uowGateway);
  const purchaseEntry = new RegisterPurchaseEntryUseCase(deps.uowGateway, deps.systemUserId);

  return [
    {
      eventType: 'plugin.activated',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { organizationId: string; code: string };
        await pluginActivated.execute(p);
      },
    },
    {
      eventType: 'plugin.deactivated',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { organizationId: string; code: string };
        await pluginDeactivated.execute(p);
      },
    },
    {
      eventType: 'organization.org.updated',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { organizationId: string };
        if (!p.organizationId) throw new Error('payload sin organizationId');
        await ensureDefault.execute(p.organizationId);
      },
    },
    {
      eventType: 'organization.establishment.created',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { organizationId: string; establishmentId: string; code: string; name?: string };
        await ensureEstablishment.execute({ organizationId: p.organizationId, establishmentId: p.establishmentId, code: p.code ?? p.establishmentId, name: p.name });
      },
    },
    {
      eventType: 'product.product.created',
      handle: async (payload: unknown): Promise<void> => {
        await refreshProduct.syncFromEvent(payload as Parameters<RefreshProductReadModelUseCase['syncFromEvent']>[0]);
      },
    },
    {
      eventType: 'product.product.updated',
      handle: async (payload: unknown): Promise<void> => {
        await refreshProduct.syncFromEvent(payload as Parameters<RefreshProductReadModelUseCase['syncFromEvent']>[0]);
      },
    },
    {
      eventType: 'product.product.disabled',
      handle: async (payload: unknown): Promise<void> => {
        const p = payload as { productId: string; organizationId: string };
        await refreshProduct.markInactive(p.organizationId, p.productId);
      },
    },
    {
      eventType: 'billing.invoice.issued',
      handle: async (payload: unknown): Promise<void> => {
        await invoiceIssued.execute(payload as Parameters<HandleInvoiceIssuedUseCase['execute']>[0]);
      },
    },
    {
      eventType: 'billing.invoice.voided',
      handle: async (payload: unknown): Promise<void> => {
        await invoiceVoided.execute(payload as Parameters<HandleInvoiceVoidedUseCase['execute']>[0]);
      },
    },
    {
      eventType: 'purchase.purchase_order.received',
      handle: async (payload: unknown): Promise<void> => {
        await purchaseEntry.execute(payload as Parameters<RegisterPurchaseEntryUseCase['execute']>[0]);
      },
    },
  ];
}

export async function startEventConsumers(params: {
  sequelize: Sequelize;
  rabbitmqUrl: string;
  exchange: string;
  queue: string;
  handlers: EventHandler[];
}): Promise<void> {
  const consumer = new InboxConsumer({
    sequelize: params.sequelize,
    rabbitmqUrl: params.rabbitmqUrl,
    exchange: params.exchange,
    queue: params.queue,
    bindings: [...CONSUMED_BINDINGS],
    handlers: params.handlers,
  });
  await consumer.start();
}