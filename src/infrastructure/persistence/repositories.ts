import { Op, QueryTypes, Transaction } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import { sequelize } from './sequelize.js';
import {
  InventoryGapModel,
  OrganizationPluginModel,
  OutboxModel,
  ProductReadModelModel,
  StockLayerModel,
  StockMovementModel,
  StockPositionModel,
  WarehouseModel,
} from './models.js';
import {
  InventoryGap,
  OrganizationPlugin,
  ProductReadModel,
  StockLayer,
  StockMovement,
  StockPosition,
  Warehouse,
} from '../../domain/entities.js';
import {
  DomainEvent,
  InventoryGapRepository,
  OrganizationPluginRepository,
  OutboxRepository,
  ProductRepository,
  StockLayerRepository,
  StockMovementRepository,
  StockPositionRepository,
  UnitOfWork,
  WarehouseRepository,
} from '../../domain/repositories.js';
import { Quantity } from '../../domain/value-objects.js';

// ── Mappers ─────────────────────────────────────────────────────────────────

function toWarehouse(m: WarehouseModel): Warehouse {
  return Warehouse.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    establishmentId: m.establishment_id,
    code: m.code,
    name: m.name,
    address: m.address,
    isDefault: m.is_default,
    status: m.status,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  });
}

function toStockPosition(m: StockPositionModel): StockPosition {
  return StockPosition.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    productId: m.product_id,
    warehouseId: m.warehouse_id,
    quantityOnHand: m.quantity_on_hand,
    quantityReserved: m.quantity_reserved,
    quantityAvailable: m.quantity_available,
    averageCostCents: Number(m.average_cost_cents),
    currencyCode: m.currency_code,
    updatedAt: m.updated_at,
  });
}

function toStockMovement(m: StockMovementModel): StockMovement {
  return StockMovement.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    productId: m.product_id,
    warehouseId: m.warehouse_id,
    type: m.type,
    quantity: Quantity.fromString(m.quantity),
    unitCostCents: m.unit_cost_cents === null ? null : Number(m.unit_cost_cents),
    totalCostCents: m.total_cost_cents === null ? null : Number(m.total_cost_cents),
    currencyCode: m.currency_code,
    referenceType: m.reference_type,
    referenceId: m.reference_id,
    accountingNature: m.accounting_nature,
    reasonCode: m.reason_code,
    lotId: m.lot_id,
    notes: m.notes,
    createdBy: m.created_by,
    createdAt: m.created_at,
  });
}

function toStockLayer(m: StockLayerModel): StockLayer {
  return StockLayer.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    productId: m.product_id,
    warehouseId: m.warehouse_id,
    entryMovementId: m.entry_movement_id,
    quantityRemaining: Quantity.fromString(m.quantity_remaining),
    unitCostCents: Number(m.unit_cost_cents),
    currencyCode: m.currency_code,
    enteredAt: m.entered_at,
    lotId: m.lot_id,
  });
}

function toProductReadModel(m: ProductReadModelModel): ProductReadModel {
  return ProductReadModel.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    name: m.name,
    sku: m.sku,
    type: m.type,
    trackStock: m.track_stock,
    allowNegativeStock: m.allow_negative_stock,
    valuationMethod: m.valuation_method,
    status: m.status,
    inventoryAccountCode: m.inventory_account_code,
    cogsAccountCode: m.cogs_account_code,
    expenseAccountCode: m.expense_account_code,
  });
}

function toOrganizationPlugin(m: OrganizationPluginModel): OrganizationPlugin {
  return OrganizationPlugin.fromPersistence({
    organizationId: m.organization_id,
    pluginCode: m.plugin_code,
    status: m.status,
    updatedAt: m.updated_at,
  });
}

function toInventoryGap(m: InventoryGapModel): InventoryGap {
  return InventoryGap.fromPersistence({
    id: m.id,
    organizationId: m.organization_id,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    skippedMovements: m.skipped_movements,
  });
}

// ── Factories de repositorios (comparten la transacción del UnitOfWork) ─────

function warehouseRepository(tx?: Transaction): WarehouseRepository {
  return {
    async findById(id) {
      const m = await WarehouseModel.findByPk(id, { transaction: tx });
      return m ? toWarehouse(m) : null;
    },
    async findByCode(organizationId, code) {
      const m = await WarehouseModel.findOne({
        where: { organization_id: organizationId, code },
        transaction: tx,
      });
      return m ? toWarehouse(m) : null;
    },
    async listByOrganization(organizationId) {
      const rows = await WarehouseModel.findAll({
        where: { organization_id: organizationId },
        transaction: tx,
        order: [['created_at', 'ASC']],
      });
      return rows.map(toWarehouse);
    },
    async findDefault(organizationId) {
      const m = await WarehouseModel.findOne({
        where: { organization_id: organizationId, is_default: true },
        transaction: tx,
      });
      return m ? toWarehouse(m) : null;
    },
    async findByEstablishment(organizationId, establishmentId) {
      const m = await WarehouseModel.findOne({
        where: { organization_id: organizationId, establishment_id: establishmentId },
        transaction: tx,
      });
      return m ? toWarehouse(m) : null;
    },
    async existsByCode(organizationId, code, excludeId) {
      const where: Record<string, unknown> = { organization_id: organizationId, code };
      if (excludeId) where.id = { [Op.ne]: excludeId };
      const count = await WarehouseModel.count({ where, transaction: tx });
      return count > 0;
    },
    async save(warehouse) {
      const p = warehouse.toPersistence();
      // is_default=false en todas las demás lo maneja el caso de uso antes de
      // llegar aquí; este upsert escribe SOLO la fila de la bodega.
      await WarehouseModel.upsert(
        {
          id: p.id,
          organization_id: p.organizationId,
          establishment_id: p.establishmentId,
          code: p.code,
          name: p.name,
          address: p.address,
          is_default: p.isDefault,
          status: p.status,
          created_at: p.createdAt,
          updated_at: new Date(),
        },
        { transaction: tx },
      );
    },
    async countByOrganization(organizationId) {
      return WarehouseModel.count({ where: { organization_id: organizationId }, transaction: tx });
    },
  };
}

function productRepository(tx?: Transaction): ProductRepository {
  return {
    async findById(organizationId, productId) {
      const m = await ProductReadModelModel.findOne({
        where: { id: productId, organization_id: organizationId },
        transaction: tx,
      });
      return m ? toProductReadModel(m) : null;
    },
    async findManyByIds(organizationId, productIds) {
      if (productIds.length === 0) return [];
      const rows = await ProductReadModelModel.findAll({
        where: { id: { [Op.in]: productIds }, organization_id: organizationId },
        transaction: tx,
      });
      return rows.map(toProductReadModel);
    },
    async upsert(product) {
      const p = product.toPersistence();
      await ProductReadModelModel.upsert(
        {
          id: p.id,
          organization_id: p.organizationId,
          name: p.name,
          sku: p.sku,
          type: p.type,
          track_stock: p.trackStock,
          allow_negative_stock: p.allowNegativeStock,
          valuation_method: p.valuationMethod,
          status: p.status,
          inventory_account_code: p.inventoryAccountCode,
          cogs_account_code: p.cogsAccountCode,
          expense_account_code: p.expenseAccountCode,
        },
        { transaction: tx },
      );
    },
    async save(product) {
      await this.upsert(product);
    },
  };
}

function stockPositionRepository(tx?: Transaction): StockPositionRepository {
  return {
    async find(organizationId, warehouseId, productId) {
      // LOCK.UPDATE: dos eventos concurrentes de la misma posición no deben
      // leer el mismo on_hand y perder una escritura (carrera clásica del kardex).
      const m = await StockPositionModel.findOne({
        where: { organization_id: organizationId, warehouse_id: warehouseId, product_id: productId },
        lock: tx ? tx.LOCK.UPDATE : undefined,
        transaction: tx,
      });
      return m ? toStockPosition(m) : null;
    },
    async findByProduct(organizationId, productId) {
      const rows = await StockPositionModel.findAll({
        where: { organization_id: organizationId, product_id: productId },
        transaction: tx,
      });
      return rows.map(toStockPosition);
    },
    async findByWarehouse(organizationId, warehouseId) {
      const rows = await StockPositionModel.findAll({
        where: { organization_id: organizationId, warehouse_id: warehouseId },
        transaction: tx,
      });
      return rows.map(toStockPosition);
    },
    async listStock(organizationId, filters) {
      const where: Record<string, unknown> = { organization_id: organizationId };
      if (filters.productId) where.product_id = filters.productId;
      if (filters.warehouseId) where.warehouse_id = filters.warehouseId;
      if (filters.stockState === 'with_stock') where.quantity_on_hand = { [Op.gt]: 0 };
      if (filters.stockState === 'without_stock') where.quantity_on_hand = 0;
      const page = Math.max(1, filters.page);
      const pageSize = Math.min(Math.max(1, filters.pageSize), 200);
      const { rows, count } = await StockPositionModel.findAndCountAll({
        where,
        transaction: tx,
        order: [['updated_at', 'DESC'], ['id', 'ASC']],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { entries: rows.map(toStockPosition), total: count };
    },
    async save(position) {
      const p = position.toPersistence();
      await StockPositionModel.upsert(
        {
          id: p.id,
          organization_id: p.organizationId,
          product_id: p.productId,
          warehouse_id: p.warehouseId,
          quantity_on_hand: p.quantityOnHand,
          quantity_reserved: p.quantityReserved,
          quantity_available: p.quantityAvailable,
          average_cost_cents: p.averageCostCents,
          currency_code: p.currencyCode,
          updated_at: new Date(),
        },
        { transaction: tx },
      );
    },
    async saveMany(positions) {
      for (const position of positions) await this.save(position);
    },
  };
}

function stockMovementRepository(tx?: Transaction): StockMovementRepository {
  return {
    async save(movement) {
      const p = movement.toPersistence();
      await StockMovementModel.create(
        {
          id: p.id,
          organization_id: p.organizationId,
          product_id: p.productId,
          warehouse_id: p.warehouseId,
          type: p.type,
          quantity: p.quantity.toFixed(),
          unit_cost_cents: p.unitCostCents,
          total_cost_cents: p.totalCostCents,
          currency_code: p.currencyCode,
          reference_type: p.referenceType,
          reference_id: p.referenceId,
          accounting_nature: p.accountingNature,
          reason_code: p.reasonCode,
          lot_id: p.lotId,
          notes: p.notes,
          created_by: p.createdBy,
          created_at: p.createdAt,
        },
        { transaction: tx },
      );
    },
    async findById(id) {
      const m = await StockMovementModel.findByPk(id, { transaction: tx });
      return m ? toStockMovement(m) : null;
    },
    async findExisting(organizationId, referenceType, referenceId, type) {
      const m = await StockMovementModel.findOne({
        where: { organization_id: organizationId, reference_type: referenceType, reference_id: referenceId, type },
        transaction: tx,
      });
      return m ? toStockMovement(m) : null;
    },
    async listByProduct(organizationId, productId, warehouseId, limit, cursor) {
      const where: Record<string, unknown> = { organization_id: organizationId, product_id: productId };
      if (warehouseId) where.warehouse_id = warehouseId;
      if (cursor) {
        // Keset pagination: trae solo filas más viejas que el cursor.
        const cursorRow = await StockMovementModel.findByPk(cursor, { transaction: tx, attributes: ['created_at', 'id'] });
        if (cursorRow) {
          where[Op.and as unknown as string] = [
            { created_at: { [Op.lt]: cursorRow.created_at } },
            { id: { [Op.ne]: cursor } },
          ];
        }
        // Si el cursor no existe se ignora (página igualmente acotada por limit).
      }
      const rows = await StockMovementModel.findAll({
        where,
        transaction: tx,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit: Math.min(limit, 200),
      });
      return rows.map(toStockMovement);
    },
    async listByReference(organizationId, referenceType, referenceId, type) {
      const where: Record<string, unknown> = {
        organization_id: organizationId,
        reference_type: referenceType,
        reference_id: referenceId,
      };
      if (type) where.type = type;
      const rows = await StockMovementModel.findAll({
        where,
        transaction: tx,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
      });
      return rows.map(toStockMovement);
    },
    async hasReconcilingMovementAfter(organizationId, after) {
      // "Resolver el hueco" = un saldo inicial o un conteo físico (ajuste con
      // reason_code physical_count) posterior al cierre del hueco.
      const count = await StockMovementModel.count({
        where: {
          organization_id: organizationId,
          created_at: { [Op.gt]: after },
          [Op.or]: [
            { type: 'opening_balance' },
            { type: { [Op.in]: ['adjustment_in', 'adjustment_out'] }, reason_code: 'physical_count' },
          ],
        },
        transaction: tx,
      });
      return count > 0;
    },
    async listMovements(organizationId, filters) {
      const where: Record<string, unknown> = { organization_id: organizationId, product_id: filters.productId };
      if (filters.warehouseId) where.warehouse_id = filters.warehouseId;
      if (filters.type) where.type = filters.type;
      if (filters.referenceType) where.reference_type = filters.referenceType;
      if (filters.referenceId) where.reference_id = filters.referenceId;
      if (filters.from || filters.to) {
        where.created_at = {
          ...(filters.from ? { [Op.gte]: filters.from } : {}),
          ...(filters.to ? { [Op.lte]: filters.to } : {}),
        };
      }
      const page = Math.max(1, filters.page);
      const pageSize = Math.min(Math.max(1, filters.pageSize), 200);
      const { rows, count } = await StockMovementModel.findAndCountAll({
        where,
        transaction: tx,
        order: [['created_at', 'DESC'], ['id', 'DESC']],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { entries: rows.map(toStockMovement), total: count };
    },
    async getStockSummary(organizationId, productId) {
      const rows = (await sequelize.query(
        `SELECT COALESCE(SUM(sm.quantity), 0) AS total_quantity,
                COALESCE(SUM(sm.total_cost_cents), 0) AS total_cost_cents,
                MAX(sm.currency_code) AS currency_code
         FROM stock_movements sm
         WHERE sm.organization_id = ? AND sm.product_id = ?`,
        {
          replacements: [organizationId, productId],
          type: QueryTypes.SELECT,
          transaction: tx,
        },
      )) as { total_quantity: string; total_cost_cents: string; currency_code: string }[];
      const row = rows[0];
      if (!row) return null;
      return {
        totalQuantity: Quantity.fromString(row.total_quantity),
        totalCostCents: Number(row.total_cost_cents) || 0,
        currencyCode: row.currency_code || 'USD',
      };
    },
  };
}

function stockLayerRepository(tx?: Transaction): StockLayerRepository {
  return {
    async findByProductAndWarehouse(organizationId, productId, warehouseId) {
      const rows = await StockLayerModel.findAll({
        where: { organization_id: organizationId, product_id: productId, warehouse_id: warehouseId },
        transaction: tx,
        order: [['entered_at', 'ASC']],
      });
      return rows.map(toStockLayer);
    },
    async findActiveLayers(organizationId, productId, warehouseId) {
      // Solo capas con saldo > 0, en orden de entrada. LOCK: FIFO debe consumir
      // sobre la misma fotografía que la posición bloqueada.
      const rows = await StockLayerModel.findAll({
        where: {
          organization_id: organizationId,
          product_id: productId,
          warehouse_id: warehouseId,
          quantity_remaining: { [Op.gt]: 0 },
        },
        lock: tx ? tx.LOCK.UPDATE : undefined,
        transaction: tx,
        order: [['entered_at', 'ASC']],
      });
      return rows.map(toStockLayer);
    },
    async save(layer) {
      const p = layer.toPersistence();
      await StockLayerModel.upsert(
        {
          id: p.id,
          organization_id: p.organizationId,
          product_id: p.productId,
          warehouse_id: p.warehouseId,
          entry_movement_id: p.entryMovementId,
          quantity_remaining: p.quantityRemaining.toFixed(),
          unit_cost_cents: p.unitCostCents,
          currency_code: p.currencyCode,
          entered_at: p.enteredAt,
          lot_id: p.lotId,
        },
        { transaction: tx },
      );
    },
    async saveMany(layers) {
      for (const layer of layers) await this.save(layer);
    },
    async persistOutgoing(consumed, created) {
      for (const layer of consumed.concat(created)) await this.save(layer);
    },
  };
}

function organizationPluginRepository(tx?: Transaction, coldStart?: (organizationId: string, pluginCode: string) => Promise<boolean | null>): OrganizationPluginRepository {
  return {
    async find(organizationId, pluginCode) {
      const m = await OrganizationPluginModel.findOne({
        where: { organization_id: organizationId, plugin_code: pluginCode },
        transaction: tx,
      });
      return m ? toOrganizationPlugin(m) : null;
    },
    async getActivationState(organizationId, pluginCode) {
      const existing = await this.find(organizationId, pluginCode);
      if (existing) return existing.isActive();
      if (!coldStart) return true; // Sin catcher remoto la duda se resuelve procesando.
      const remote = await coldStart(organizationId, pluginCode);
      if (remote === null) return true; // Catcher no concluyente (service down): procesa.
      await this.save(OrganizationPlugin.create({ organizationId, pluginCode, status: remote ? 'active' : 'disabled' }));
      return remote;
    },
    async save(plugin) {
      await OrganizationPluginModel.upsert(
        {
          organization_id: plugin.organizationId,
          plugin_code: plugin.pluginCode,
          status: plugin.status,
          updated_at: new Date(),
        },
        { transaction: tx },
      );
    },
    setColdStartCallback(cb) {
      // El catcher se fija a nivel de fábrica (no por transacción); este método
      // es la firma exigida por el contrato, pero la implementación real pasa el
      // catcher por constructor. Se mantiene para tests in-memory.
      coldStart = cb;
    },
  };
}

function inventoryGapRepository(tx?: Transaction): InventoryGapRepository {
  return {
    async findOpenGap(organizationId) {
      const m = await InventoryGapModel.findOne({
        where: { organization_id: organizationId, ended_at: null },
        transaction: tx,
        order: [['started_at', 'DESC']],
      });
      return m ? toInventoryGap(m) : null;
    },
    async findLastClosedGap(organizationId) {
      const m = await InventoryGapModel.findOne({
        where: { organization_id: organizationId, ended_at: { [Op.ne]: null } },
        transaction: tx,
        order: [['started_at', 'DESC']],
      });
      return m ? toInventoryGap(m) : null;
    },
    async save(gap) {
      const p = gap.toPersistence();
      await InventoryGapModel.upsert(
        {
          id: p.id,
          organization_id: p.organizationId,
          started_at: p.startedAt,
          ended_at: p.endedAt,
          skipped_movements: p.skippedMovements,
        },
        { transaction: tx },
      );
    },
  };
}

function outboxRepository(tx?: Transaction): OutboxRepository {
  return {
    async add(event: DomainEvent) {
      await OutboxModel.create(
        {
          id: event.eventId,
          aggregate_type: event.aggregateType,
          aggregate_id: event.aggregateId,
          type: event.type,
          // Inyecta actor/ip/request-id desde el contexto de la petición para
          // que el auditor sepa QUIÉN hizo cada cosa (mismo patrón que
          // product-service).
          payload: withActor(event.payload),
          occurred_at: event.occurredAt,
          processed_at: null,
        },
        { transaction: tx },
      );
    },
  };
}

// ── Ensamblaje ──────────────────────────────────────────────────────────────

export function buildRepositories(tx?: Transaction, coldStart?: (organizationId: string, pluginCode: string) => Promise<boolean | null>): UnitOfWork {
  return {
    warehouses: warehouseRepository(tx),
    products: productRepository(tx),
    stockPositions: stockPositionRepository(tx),
    stockLayers: stockLayerRepository(tx),
    stockMovements: stockMovementRepository(tx),
    organizationPlugins: organizationPluginRepository(tx, coldStart),
    inventoryGaps: inventoryGapRepository(tx),
    outbox: outboxRepository(tx),
  };
}

/** UnitOfWork de lectura directa, sin transacción (listados, consultas). */
export const readOnlyRepositories: UnitOfWork = buildRepositories(undefined);

export class SequelizeUnitOfWork implements UnitOfWork {
  readonly warehouses: WarehouseRepository;
  readonly products: ProductRepository;
  readonly stockPositions: StockPositionRepository;
  readonly stockLayers: StockLayerRepository;
  readonly stockMovements: StockMovementRepository;
  readonly organizationPlugins: OrganizationPluginRepository;
  readonly inventoryGaps: InventoryGapRepository;
  readonly outbox: OutboxRepository;

  constructor(
    readonly tx: Transaction,
    coldStart?: (organizationId: string, pluginCode: string) => Promise<boolean | null>,
  ) {
    const repos = buildRepositories(tx, coldStart);
    this.warehouses = repos.warehouses;
    this.products = repos.products;
    this.stockPositions = repos.stockPositions;
    this.stockLayers = repos.stockLayers;
    this.stockMovements = repos.stockMovements;
    this.organizationPlugins = repos.organizationPlugins;
    this.inventoryGaps = repos.inventoryGaps;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory {
  constructor(
    private readonly coldStart?: (organizationId: string, pluginCode: string) => Promise<boolean | null>,
    private readonly onCommit?: (tx: Transaction) => void,
  ) {}

  async begin(): Promise<SequelizeUnitOfWork> {
    const tx = await sequelize.transaction();
    // El relay publica el outbox justo tras el commit; sin este enganche los
    // eventos esperan los 30s del timer de respaldo del relay.
    this.onCommit?.(tx);
    return new SequelizeUnitOfWork(tx, this.coldStart);
  }
}