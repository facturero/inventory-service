import type {
  InventoryGap,
  OrganizationPlugin,
  ProductReadModel,
  StockLayer,
  StockMovement,
  StockPosition,
  Warehouse,
} from './entities.js';
import type { MovementType } from './entities.js';
import type { StockMovementProps } from './entities.js';
import type { Quantity } from './value-objects.js';

export interface WarehouseRepository {
  findById(id: string): Promise<Warehouse | null>;
  findByCode(organizationId: string, code: string): Promise<Warehouse | null>;
  listByOrganization(organizationId: string): Promise<Warehouse[]>;
  findDefault(organizationId: string): Promise<Warehouse | null>;
  findByEstablishment(organizationId: string, establishmentId: string): Promise<Warehouse | null>;
  existsByCode(organizationId: string, code: string, excludeId?: string): Promise<boolean>;
  save(warehouse: Warehouse): Promise<void>;
  countByOrganization(organizationId: string): Promise<number>;
}

export interface ProductRepository {
  findById(organizationId: string, productId: string): Promise<ProductReadModel | null>;
  findManyByIds(organizationId: string, productIds: string[]): Promise<ProductReadModel[]>;
  upsert(product: ProductReadModel): Promise<void>;
  save(product: ProductReadModel): Promise<void>;
}

export interface StockPositionRepository {
  find(organizationId: string, warehouseId: string, productId: string): Promise<StockPosition | null>;
  findByProduct(organizationId: string, productId: string): Promise<StockPosition[]>;
  findByWarehouse(organizationId: string, warehouseId: string): Promise<StockPosition[]>;
  listStock(organizationId: string, filters: StockListFilters): Promise<{ entries: StockPosition[]; total: number }>;
  save(position: StockPosition): Promise<void>;
  saveMany(positions: StockPosition[]): Promise<void>;
}

export type StockStateFilter = 'with_stock' | 'without_stock';

export interface StockListFilters {
  productId?: string;
  warehouseId?: string;
  stockState?: StockStateFilter;
  page: number;
  pageSize: number;
}

export interface StockLayerRepository {
  findByProductAndWarehouse(organizationId: string, productId: string, warehouseId: string): Promise<StockLayer[]>;
  /** Capas vivas ordenadas por `entered_at` ASC (de más antigua a más nueva). */
  findActiveLayers(organizationId: string, productId: string, warehouseId: string): Promise<StockLayer[]>;
  save(layer: StockLayer): Promise<void>;
  saveMany(layers: StockLayer[]): Promise<void>;
  /** Persiste el consumo de una salida: consumidos quedan en 0 (isExhausted). */
  persistOutgoing(consumed: StockLayer[], created: StockLayer[]): Promise<void>;
}

export interface StockMovementRepository {
  save(movement: StockMovement): Promise<void>;
  findById(id: string): Promise<StockMovement | null>;
  /** Busca un movimiento que describa la misma operación (idempotencia). */
  findExisting(
    organizationId: string,
    referenceType: string,
    referenceId: string,
    type: StockMovementProps['type'],
  ): Promise<StockMovement | null>;
  listByProduct(
    organizationId: string,
    productId: string,
    warehouseId: string | null,
    limit: number,
    cursor: string | null,
  ): Promise<StockMovement[]>;
  /** Todos los movimientos de una referencia (ej. todos los sale_out de una factura). */
  listByReference(organizationId: string, referenceType: string, referenceId: string, type?: StockMovementProps['type']): Promise<StockMovement[]>;
  /** `true` si existe un saldo inicial o un conteo físico posterior a `after`.
   *  Es lo que determina que el hueco del plugin quedó RESUELTO (Definition of done #15). */
  hasReconcilingMovementAfter(organizationId: string, after: Date): Promise<boolean>;
  /** Kardex paginado con filtros (Definition of done #11). */
  listMovements(organizationId: string, filters: MovementListFilters): Promise<{ entries: StockMovement[]; total: number }>;
  getStockSummary(organizationId: string, productId: string): Promise<{
    totalQuantity: Quantity;
    totalCostCents: number;
    currencyCode: string;
  } | null>;
}

export interface OrganizationPluginRepository {
  find(organizationId: string, pluginCode: string): Promise<OrganizationPlugin | null>;
  /** Estado de un plugin con warm-start: si no existe en la tabla, cold fetch. */
  getActivationState(organizationId: string, pluginCode: string): Promise<boolean>;
  save(plugin: OrganizationPlugin): Promise<void>;
  setColdStartCallback(cb: (organizationId: string, pluginCode: string) => Promise<boolean | null>): void;
}

export interface InventoryGapRepository {
  findOpenGap(organizationId: string): Promise<InventoryGap | null>;
  /** Último hueco cerrado; es la base del `staleWarning` de GET /stock. */
  findLastClosedGap(organizationId: string): Promise<InventoryGap | null>;
  save(gap: InventoryGap): Promise<void>;
}

export interface MovementListFilters {
  productId: string;
  warehouseId?: string;
  type?: MovementType;
  referenceType?: string;
  referenceId?: string;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/** Evento de dominio saliente: se persiste en `outbox_messages` y el relay lo
 *  publica a RabbitMQ. El payload debe ser plano y serializable. */
export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

/** Unidad de trabajo sobre la transacción del scheduler/sim-hallazgo. Todos los
 *  repos + hooks de eventos dentro de un caso de uso deben operar el mismo TX. */
export interface UnitOfWork {
  warehouses: WarehouseRepository;
  products: ProductRepository;
  stockPositions: StockPositionRepository;
  stockLayers: StockLayerRepository;
  stockMovements: StockMovementRepository;
  organizationPlugins: OrganizationPluginRepository;
  inventoryGaps: InventoryGapRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWorkFactory {
  begin(): Promise<UnitOfWork>;
}

/** Cola de eventos (RabbitMQ), para los eventos de dominio del scheduler. */
export interface OutboxCommandSender {
  publish<M>(props: { routingKey: string; eventType: string; message: M; organizationId: string; correlationId: string | null }): Promise<void>;
}