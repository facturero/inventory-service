import type {
  DomainEvent,
  InventoryGap,
  MovementListFilters,
  OrganizationPlugin,
  ProductReadModel,
  StockLayer,
  StockListFilters,
  StockMovement,
  StockPosition,
  UnitOfWork,
  Warehouse,
  WarehouseRepository,
  ProductRepository,
  StockPositionRepository,
  StockLayerRepository,
  StockMovementRepository,
  OrganizationPluginRepository,
  InventoryGapRepository,
  OutboxRepository,
} from '../domain/repositories.js';
import {
  ProductReadModel as ProductReadModelEntity,
  StockLayer as StockLayerEntity,
  StockPosition as StockPositionEntity,
  Warehouse as WarehouseEntity,
} from '../domain/entities.js';

/** Copia profunda de las entidades MUTABLES. `StockPosition` y `StockLayer` se
 *  modifican in situ (applyEntry / applyExit / consume), así que copiar el Map
 *  no basta: las dos copias apuntarían al mismo objeto y el rollback no
 *  desharía nada. Las demás entidades no mutan y se pueden compartir. */
function clonePosition(p: StockPosition): StockPosition {
  return StockPositionEntity.fromPersistence({
    id: p.id,
    organizationId: p.organizationId,
    productId: p.productId,
    warehouseId: p.warehouseId,
    quantityOnHand: p.quantityOnHand.toFixed(),
    quantityReserved: p.quantityReserved.toFixed(),
    quantityAvailable: p.quantityAvailable.toFixed(),
    averageCostCents: p.averageCost.toCents(),
    currencyCode: p.currencyCode,
    updatedAt: new Date(p.updatedAt),
  });
}

function cloneLayer(l: StockLayer): StockLayer {
  return StockLayerEntity.fromPersistence({
    id: l.id,
    organizationId: l.organizationId,
    productId: l.productId,
    warehouseId: l.warehouseId,
    entryMovementId: l.entryMovementId,
    quantityRemaining: l.quantityRemaining,
    unitCostCents: l.unitCostCents,
    currencyCode: l.currencyCode,
    enteredAt: new Date(l.enteredAt),
    lotId: l.lotId,
  });
}

function cloneMap<T>(src: Map<string, T>, clone: (v: T) => T): Map<string, T> {
  const out = new Map<string, T>();
  for (const [k, v] of src) out.set(k, clone(v));
  return out;
}

/** Unit of Work en memoria para tests. Cada test crea una instancia fresca; los
 *  repos comparten el mismo store subyacente (simula una transacción única). */
export class InMemoryUnitOfWork implements UnitOfWork {
  private warehouseMap = new Map<string, Warehouse>();
  private productMap = new Map<string, ProductReadModel>();
  private positionMap = new Map<string, StockPosition>(); // key: org:wh:prod
  private layerMap = new Map<string, StockLayer>();
  private movementMap = new Map<string, StockMovement>();
  private pluginMap = new Map<string, OrganizationPlugin>(); // key: org:code
  private gapMap = new Map<string, InventoryGap>();
  private coldStartCallback: ((orgId: string, code: string) => Promise<boolean | null>) | null = null;

  readonly outboxEvents: DomainEvent[] = [];

  // Snapshot para simular rollback de transacción en tests de atomicidad.
  private snapshotStore: {
    warehouseMap: Map<string, Warehouse>;
    positionMap: Map<string, StockPosition>;
    layerMap: Map<string, StockLayer>;
    movementMap: Map<string, StockMovement>;
    pluginMap: Map<string, OrganizationPlugin>;
    gapMap: Map<string, InventoryGap>;
    productMap: Map<string, ProductReadModel>;
    outboxLength: number;
  } | null = null;

  snapshot(): void {
    this.snapshotStore = {
      warehouseMap: new Map(this.warehouseMap),
      positionMap: cloneMap(this.positionMap, clonePosition),
      layerMap: cloneMap(this.layerMap, cloneLayer),
      movementMap: new Map(this.movementMap),
      pluginMap: new Map(this.pluginMap),
      gapMap: new Map(this.gapMap),
      productMap: new Map(this.productMap),
      outboxLength: this.outboxEvents.length,
    };
  }

  async commit(): Promise<void> {
    this.snapshotStore = null;
  }

  async rollback(): Promise<void> {
    if (!this.snapshotStore) return;
    this.warehouseMap = this.snapshotStore.warehouseMap;
    this.positionMap = this.snapshotStore.positionMap;
    this.layerMap = this.snapshotStore.layerMap;
    this.movementMap = this.snapshotStore.movementMap;
    this.pluginMap = this.snapshotStore.pluginMap;
    this.gapMap = this.snapshotStore.gapMap;
    this.productMap = this.snapshotStore.productMap;
    this.outboxEvents.length = this.snapshotStore.outboxLength;
    this.snapshotStore = null;
  }

  // ── Warehouses ──────────────────────────────────────────────────────────

  readonly warehouses: WarehouseRepository = {
    findById: async (id) => [...this.warehouseMap.values()].find((w) => w.id === id) ?? null,

    findByCode: async (orgId, code) =>
      [...this.warehouseMap.values()].find((w) => w.organizationId === orgId && w.code === code) ?? null,

    listByOrganization: async (orgId) =>
      [...this.warehouseMap.values()].filter((w) => w.organizationId === orgId),

    findDefault: async (orgId) =>
      [...this.warehouseMap.values()].find((w) => w.organizationId === orgId && w.isDefault) ?? null,

    findByEstablishment: async (orgId, estId) =>
      [...this.warehouseMap.values()].find((w) => w.organizationId === orgId && w.establishmentId === estId) ?? null,

    existsByCode: async (orgId, code, excludeId?) =>
      [...this.warehouseMap.values()].some(
        (w) => w.organizationId === orgId && w.code === code && w.id !== excludeId,
      ),

    countByOrganization: async (orgId) =>
      [...this.warehouseMap.values()].filter((w) => w.organizationId === orgId).length,

    save: async (warehouse) => { this.warehouseMap.set(warehouse.id, warehouse); },
  };

  // ── Products ────────────────────────────────────────────────────────────

  readonly products: ProductRepository = {
    findById: async (orgId, prodId) =>
      [...this.productMap.values()].find((p) => p.organizationId === orgId && p.id === prodId) ?? null,

    findManyByIds: async (orgId, ids) =>
      [...this.productMap.values()].filter((p) => p.organizationId === orgId && ids.includes(p.id)),

    upsert: async (product) => { this.productMap.set(`${product.organizationId}:${product.id}`, product); },
    save: async (product) => { this.productMap.set(`${product.organizationId}:${product.id}`, product); },
  };

  // ── Stock Positions ─────────────────────────────────────────────────────

  private positionKey(orgId: string, whId: string, prodId: string) {
    return `${orgId}:${whId}:${prodId}`;
  }

  readonly stockPositions: StockPositionRepository = {
    find: async (orgId, whId, prodId) =>
      this.positionMap.get(this.positionKey(orgId, whId, prodId)) ?? null,

    findByProduct: async (orgId, prodId) =>
      [...this.positionMap.values()].filter((p) => p.organizationId === orgId && p.productId === prodId),

    findByWarehouse: async (orgId, whId) =>
      [...this.positionMap.values()].filter((p) => p.organizationId === orgId && p.warehouseId === whId),

    listStock: async (orgId, filters: StockListFilters) => {
      let entries = [...this.positionMap.values()].filter((p) => p.organizationId === orgId);
      if (filters.productId) entries = entries.filter((p) => p.productId === filters.productId);
      if (filters.warehouseId) entries = entries.filter((p) => p.warehouseId === filters.warehouseId);
      if (filters.stockState === 'with_stock') entries = entries.filter((p) => p.quantityOnHand.isPositive());
      if (filters.stockState === 'without_stock') entries = entries.filter((p) => !p.quantityOnHand.isPositive());
      const total = entries.length;
      const start = (filters.page - 1) * filters.pageSize;
      entries = entries.slice(start, start + filters.pageSize);
      return { entries, total };
    },

    save: async (pos) => { this.positionMap.set(this.positionKey(pos.organizationId, pos.warehouseId, pos.productId), pos); },
    saveMany: async (positions) => { for (const p of positions) await this.stockPositions.save(p); },
  };

  // ── Stock Layers ────────────────────────────────────────────────────────

  readonly stockLayers: StockLayerRepository = {
    findByProductAndWarehouse: async (orgId, prodId, whId) =>
      [...this.layerMap.values()].filter(
        (l) => l.organizationId === orgId && l.productId === prodId && l.warehouseId === whId,
      ),

    findActiveLayers: async (orgId, prodId, whId) =>
      [...this.layerMap.values()]
        .filter(
          (l) =>
            l.organizationId === orgId &&
            l.productId === prodId &&
            l.warehouseId === whId &&
            l.quantityRemaining.isPositive(),
        )
        .sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime()),

    save: async (layer) => { this.layerMap.set(layer.id, layer); },
    saveMany: async (layers) => { for (const l of layers) await this.stockLayers.save(l); },

    persistOutgoing: async (consumed, created) => {
      for (const l of consumed) this.layerMap.set(l.id, l); // consume() already mutated
      for (const l of created) this.layerMap.set(l.id, l);
    },
  };

  // ── Stock Movements ─────────────────────────────────────────────────────

  readonly stockMovements: StockMovementRepository = {
    save: async (m) => { this.movementMap.set(m.id, m); },

    findById: async (id) => this.movementMap.get(id) ?? null,

    findExisting: async (orgId, refType, refId, type) =>
      [...this.movementMap.values()].find(
        (m) =>
          m.organizationId === orgId &&
          m.referenceType === refType &&
          m.referenceId === refId &&
          m.type === type,
      ) ?? null,

    listByProduct: async (orgId, prodId, whId, limit, cursor) => {
      let items = [...this.movementMap.values()]
        .filter((m) => m.organizationId === orgId && m.productId === prodId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (whId) items = items.filter((m) => m.warehouseId === whId);
      if (cursor) {
        const idx = items.findIndex((m) => m.id === cursor);
        if (idx >= 0) items = items.slice(idx + 1);
      }
      return items.slice(0, limit);
    },

    listByReference: async (orgId, refType, refId, type?) =>
      [...this.movementMap.values()]
        .filter(
          (m) =>
            m.organizationId === orgId &&
            m.referenceType === refType &&
            m.referenceId === refId &&
            (type === undefined || m.type === type),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),

    hasReconcilingMovementAfter: async (orgId, after) =>
      [...this.movementMap.values()].some(
        (m) =>
          m.organizationId === orgId &&
          m.createdAt.getTime() > after.getTime() &&
          (m.type === 'opening_balance' || m.reasonCode === 'physical_count'),
      ),

    listMovements: async (orgId, filters: MovementListFilters) => {
      let entries = [...this.movementMap.values()].filter((m) => m.organizationId === orgId && m.productId === filters.productId);
      if (filters.warehouseId) entries = entries.filter((m) => m.warehouseId === filters.warehouseId);
      if (filters.type) entries = entries.filter((m) => m.type === filters.type);
      if (filters.referenceType) entries = entries.filter((m) => m.referenceType === filters.referenceType);
      if (filters.referenceId) entries = entries.filter((m) => m.referenceId === filters.referenceId);
      if (filters.from) entries = entries.filter((m) => m.createdAt.getTime() >= filters.from!.getTime());
      if (filters.to) entries = entries.filter((m) => m.createdAt.getTime() <= filters.to!.getTime());
      const total = entries.length;
      entries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filters.page - 1) * filters.pageSize;
      entries = entries.slice(start, start + filters.pageSize);
      return { entries, total };
    },

    getStockSummary: async () => null,
  };

  // ── Organization Plugins ────────────────────────────────────────────────

  readonly organizationPlugins: OrganizationPluginRepository = {
    find: async (orgId, code) =>
      this.pluginMap.get(`${orgId}:${code}`) ?? null,

    getActivationState: async (orgId, code) => {
      const existing = this.pluginMap.get(`${orgId}:${code}`);
      if (existing) return existing.status === 'active';
      // Sin cold-start en tests: ante duda se procesa.
      return true;
    },

    save: async (plugin) => { this.pluginMap.set(`${plugin.organizationId}:${plugin.pluginCode}`, plugin); },

    setColdStartCallback: (cb) => { this.coldStartCallback = cb; },
  };

  // ── Inventory Gaps ──────────────────────────────────────────────────────

  readonly inventoryGaps: InventoryGapRepository = {
    findOpenGap: async (orgId) =>
      [...this.gapMap.values()].find((g) => g.organizationId === orgId && g.isOpen()) ?? null,

    findLastClosedGap: async (orgId) => {
      const closed = [...this.gapMap.values()]
        .filter((g) => g.organizationId === orgId && !g.isOpen())
        .sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0));
      return closed[0] ?? null;
    },

    save: async (gap) => { this.gapMap.set(gap.id, gap); },
  };

  // ── Outbox ──────────────────────────────────────────────────────────────

  readonly outbox: OutboxRepository = {
    add: async (event) => { this.outboxEvents.push(event); },
  };
}

/** Helper para crear una posición de stock directamente (sin pasar por caso de uso). */
export function createPositionInMemory(params: {
  organizationId: string;
  productId: string;
  warehouseId: string;
  quantityOnHand: string;
  quantityReserved: string;
  averageCostCents: number;
  currencyCode: string;
}) {
  const pos = StockPositionEntity.fromPersistence({
    id: '00000000-0000-0000-0000-000000000001',
    organizationId: params.organizationId,
    productId: params.productId,
    warehouseId: params.warehouseId,
    quantityOnHand: params.quantityOnHand,
    quantityReserved: params.quantityReserved,
    quantityAvailable: params.quantityOnHand,
    averageCostCents: params.averageCostCents,
    currencyCode: params.currencyCode,
    updatedAt: new Date(),
  });
  return pos;
}

/** Gateway que devuelve SIEMPRE el mismo store en memoria (simula una transacción
 *  única por caso de uso: begin toma snapshot, rollback lo restaura). */
export function inMemoryGateway(uow: InMemoryUnitOfWork) {
  return {
    begin: async (): Promise<InMemoryUnitOfWork> => {
      uow.snapshot();
      return uow;
    },
  };
}

export function seedProduct(uow: InMemoryUnitOfWork, params: {
  id: string;
  organizationId: string;
  trackStock?: boolean;
  allowNegativeStock?: boolean;
  valuationMethod?: 'weighted_average' | 'fifo';
  type?: 'good' | 'service';
}): ProductReadModel {
  const product = ProductReadModelEntity.upsert({
    id: params.id,
    organizationId: params.organizationId,
    name: 'Producto test',
    type: params.type ?? 'good',
    trackStock: params.trackStock ?? true,
    allowNegativeStock: params.allowNegativeStock ?? false,
    valuationMethod: params.valuationMethod ?? 'weighted_average',
    status: 'active',
  });
  void uow.products.upsert(product);
  return product;
}

export function seedWarehouse(uow: InMemoryUnitOfWork, params: {
  id: string;
  organizationId: string;
  code: string;
  name?: string;
  establishmentId?: string | null;
  isDefault?: boolean;
  status?: 'active' | 'inactive';
}): Warehouse {
  const warehouse = WarehouseEntity.fromPersistence({
    id: params.id,
    organizationId: params.organizationId,
    establishmentId: params.establishmentId ?? null,
    code: params.code,
    name: params.name ?? `Bodega ${params.code}`,
    address: null,
    isDefault: params.isDefault ?? false,
    status: params.status ?? 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  void uow.warehouses.save(warehouse);
  return warehouse;
}

export function seedPosition(uow: InMemoryUnitOfWork, params: {
  organizationId: string;
  productId: string;
  warehouseId: string;
  quantityOnHand: string;
  quantityReserved?: string;
  averageCostCents?: number;
  currencyCode?: string;
}): StockPosition {
  const pos = createPositionInMemory({
    organizationId: params.organizationId,
    productId: params.productId,
    warehouseId: params.warehouseId,
    quantityOnHand: params.quantityOnHand,
    quantityReserved: params.quantityReserved ?? '0.0000',
    averageCostCents: params.averageCostCents ?? 0,
    currencyCode: params.currencyCode ?? 'USD',
  });
  void uow.stockPositions.save(pos);
  return pos;
}

export const UUID = {
  ORG: '11111111-1111-1111-1111-111111111111',
  OTHER_ORG: '22222222-2222-2222-2222-222222222222',
  PRODUCT: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  PRODUCT2: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  WH: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  WH2: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  ESTABLISHMENT: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  ESTABLISHMENT2: 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2',
  USER: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
};