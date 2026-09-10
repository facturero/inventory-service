import { DataTypes, InferAttributes, InferCreationAttributes, Model } from 'sequelize';
import { sequelize } from './sequelize.js';

// Nota: `default_org_id` de warehouses es una columna GENERADA — no se declara
// aquí para que Sequelize jamás intente escribirla. Se auto-puebla con
// organization_id cuando is_default=true (garantía de una única default/org).

export class WarehouseModel extends Model<
  InferAttributes<WarehouseModel>,
  InferCreationAttributes<WarehouseModel>
> {
  declare id: string;
  declare organization_id: string;
  declare establishment_id: string | null;
  declare code: string;
  declare name: string;
  declare address: string | null;
  declare is_default: boolean;
  declare status: 'active' | 'inactive';
  declare created_at: Date;
  declare updated_at: Date;
}

WarehouseModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    establishment_id: { type: DataTypes.CHAR(36), allowNull: true },
    code: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    address: { type: DataTypes.STRING(255), allowNull: true },
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'warehouses', timestamps: false },
);

export class StockPositionModel extends Model<
  InferAttributes<StockPositionModel>,
  InferCreationAttributes<StockPositionModel>
> {
  declare id: string;
  declare organization_id: string;
  declare product_id: string;
  declare warehouse_id: string;
  declare quantity_on_hand: string;
  declare quantity_reserved: string;
  declare quantity_available: string;
  declare average_cost_cents: string | number;
  declare currency_code: string;
  declare updated_at: Date;
}

StockPositionModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    product_id: { type: DataTypes.CHAR(36), allowNull: false },
    warehouse_id: { type: DataTypes.CHAR(36), allowNull: false },
    quantity_on_hand: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
    quantity_reserved: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
    quantity_available: { type: DataTypes.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
    average_cost_cents: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'stock_positions', timestamps: false },
);

export class StockMovementModel extends Model<
  InferAttributes<StockMovementModel>,
  InferCreationAttributes<StockMovementModel>
> {
  declare id: string;
  declare organization_id: string;
  declare product_id: string;
  declare warehouse_id: string;
  declare type: 'purchase_in' | 'sale_out' | 'transfer_out' | 'transfer_in' | 'adjustment_in' | 'adjustment_out' | 'reservation' | 'release' | 'opening_balance';
  declare quantity: string;
  declare unit_cost_cents: string | number | null;
  declare total_cost_cents: string | number | null;
  declare currency_code: string;
  declare reference_type: string | null;
  declare reference_id: string | null;
  declare accounting_nature: 'inventory_in' | 'inventory_gain' | 'cogs' | 'expense' | 'shrinkage' | 'internal_transfer';
  declare reason_code: string | null;
  declare lot_id: string | null;
  declare notes: string | null;
  declare created_by: string;
  declare created_at: Date;
}

StockMovementModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    product_id: { type: DataTypes.CHAR(36), allowNull: false },
    warehouse_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: {
      type: DataTypes.ENUM(
        'purchase_in',
        'sale_out',
        'transfer_out',
        'transfer_in',
        'adjustment_in',
        'adjustment_out',
        'reservation',
        'release',
        'opening_balance',
      ),
      allowNull: false,
    },
    quantity: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
    unit_cost_cents: { type: DataTypes.BIGINT, allowNull: true },
    total_cost_cents: { type: DataTypes.BIGINT, allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false, defaultValue: 'USD' },
    reference_type: { type: DataTypes.STRING(30), allowNull: true },
    reference_id: { type: DataTypes.CHAR(36), allowNull: true },
    accounting_nature: {
      type: DataTypes.ENUM('inventory_in', 'inventory_gain', 'cogs', 'expense', 'shrinkage', 'internal_transfer'),
      allowNull: false,
    },
    reason_code: { type: DataTypes.STRING(30), allowNull: true },
    lot_id: { type: DataTypes.CHAR(36), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.CHAR(36), allowNull: false },
    created_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'stock_movements', timestamps: false },
);

export class StockLayerModel extends Model<
  InferAttributes<StockLayerModel>,
  InferCreationAttributes<StockLayerModel>
> {
  declare id: string;
  declare organization_id: string;
  declare product_id: string;
  declare warehouse_id: string;
  declare entry_movement_id: string;
  declare quantity_remaining: string;
  declare unit_cost_cents: string | number;
  declare currency_code: string;
  declare entered_at: Date;
  declare lot_id: string | null;
}

StockLayerModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    product_id: { type: DataTypes.CHAR(36), allowNull: false },
    warehouse_id: { type: DataTypes.CHAR(36), allowNull: false },
    entry_movement_id: { type: DataTypes.CHAR(36), allowNull: false },
    quantity_remaining: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
    unit_cost_cents: { type: DataTypes.BIGINT, allowNull: false },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    entered_at: { type: DataTypes.DATE, allowNull: false },
    lot_id: { type: DataTypes.CHAR(36), allowNull: true },
  },
  { sequelize, tableName: 'stock_layers', timestamps: false },
);

export class ReservationModel extends Model<
  InferAttributes<ReservationModel>,
  InferCreationAttributes<ReservationModel>
> {
  declare id: string;
  declare organization_id: string;
  declare product_id: string;
  declare warehouse_id: string;
  declare quantity: string;
  declare reference_type: string;
  declare reference_id: string;
  declare status: 'active' | 'confirmed' | 'released' | 'expired';
  declare expires_at: Date | null;
  declare created_at: Date;
  declare updated_at: Date;
}

ReservationModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    product_id: { type: DataTypes.CHAR(36), allowNull: false },
    warehouse_id: { type: DataTypes.CHAR(36), allowNull: false },
    quantity: { type: DataTypes.DECIMAL(18, 4), allowNull: false },
    reference_type: { type: DataTypes.STRING(30), allowNull: false },
    reference_id: { type: DataTypes.CHAR(36), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'confirmed', 'released', 'expired'), allowNull: false, defaultValue: 'active' },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    created_at: DataTypes.DATE,
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'reservations', timestamps: false },
);

export class ProductReadModelModel extends Model<
  InferAttributes<ProductReadModelModel>,
  InferCreationAttributes<ProductReadModelModel>
> {
  declare id: string;
  declare organization_id: string;
  declare name: string | null;
  declare sku: string | null;
  declare type: 'good' | 'service' | null;
  declare track_stock: boolean;
  declare allow_negative_stock: boolean;
  declare valuation_method: 'weighted_average' | 'fifo';
  declare status: 'active' | 'inactive' | null;
  declare inventory_account_code: string | null;
  declare cogs_account_code: string | null;
  declare expense_account_code: string | null;
}

ProductReadModelModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: true },
    sku: { type: DataTypes.STRING(64), allowNull: true },
    type: { type: DataTypes.ENUM('good', 'service'), allowNull: true },
    track_stock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    allow_negative_stock: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    valuation_method: { type: DataTypes.ENUM('weighted_average', 'fifo'), allowNull: false, defaultValue: 'weighted_average' },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: true },
    inventory_account_code: { type: DataTypes.STRING(20), allowNull: true },
    cogs_account_code: { type: DataTypes.STRING(20), allowNull: true },
    expense_account_code: { type: DataTypes.STRING(20), allowNull: true },
  },
  { sequelize, tableName: 'products', timestamps: false },
);

export class OrganizationPluginModel extends Model<
  InferAttributes<OrganizationPluginModel>,
  InferCreationAttributes<OrganizationPluginModel>
> {
  declare organization_id: string;
  declare plugin_code: string;
  declare status: 'active' | 'disabled';
  declare updated_at: Date;
}

OrganizationPluginModel.init(
  {
    organization_id: { type: DataTypes.CHAR(36), allowNull: false, primaryKey: true },
    plugin_code: { type: DataTypes.STRING(60), allowNull: false, primaryKey: true },
    status: { type: DataTypes.ENUM('active', 'disabled'), allowNull: false },
    updated_at: DataTypes.DATE,
  },
  { sequelize, tableName: 'organization_plugins', timestamps: false },
);

export class InventoryGapModel extends Model<
  InferAttributes<InventoryGapModel>,
  InferCreationAttributes<InventoryGapModel>
> {
  declare id: string;
  declare organization_id: string;
  declare started_at: Date;
  declare ended_at: Date | null;
  declare skipped_movements: number;
}

InventoryGapModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    started_at: { type: DataTypes.DATE, allowNull: false },
    ended_at: { type: DataTypes.DATE, allowNull: true },
    skipped_movements: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: 'inventory_gaps', timestamps: false },
);

export class OutboxModel extends Model<
  InferAttributes<OutboxModel>,
  InferCreationAttributes<OutboxModel>
> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);

export class ProcessedEventModel extends Model<
  InferAttributes<ProcessedEventModel>,
  InferCreationAttributes<ProcessedEventModel>
> {
  declare id: string;
  declare event_type: string;
  declare routing_key: string;
  declare payload: unknown;
  declare status: string;
  declare last_error: string | null;
  declare processed_at: Date;
}

ProcessedEventModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    event_type: { type: DataTypes.STRING(100), allowNull: false },
    routing_key: { type: DataTypes.STRING(200), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'processed' },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    processed_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'processed_events', timestamps: false },
);

// Asociaciones
StockMovementModel.hasOne(StockLayerModel, { foreignKey: 'entry_movement_id', as: 'enteredLayer' });
StockLayerModel.belongsTo(StockMovementModel, { foreignKey: 'entry_movement_id', as: 'entryMovement' });

WarehouseModel.hasMany(StockPositionModel, { foreignKey: 'warehouse_id', as: 'positions' });
StockPositionModel.belongsTo(WarehouseModel, { foreignKey: 'warehouse_id' });

ProductReadModelModel.hasMany(StockPositionModel, { foreignKey: 'product_id', as: 'positions' });
StockPositionModel.belongsTo(ProductReadModelModel, { foreignKey: 'product_id' });