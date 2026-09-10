/**
 * Tablas de inventory-service (inventory_db).
 *
 * - warehouses: bodegas multi-org. La default única se garantiza con la columna
 *   generada `default_org_id` (MySQL no tiene índices parciales): su valor es
 *   organization_id solo cuando is_default=true, y los NULL no colisionan entre sí.
 * - stock_positions: posición actual por producto+bodega (denormaliza on_hand/
 *   reserved/available/avg_cost para queries rápidas).
 * - stock_movements: el kardex. Inmutable; cada fila declara su accounting_nature.
 * - stock_layers: lotes FIFO de entradas pendientes de despachar.
 * - reservations: se crea vacía y NADIE la escribe en esta fase (flujo fase 2).
 * - products: read-model local alimentado por events de product-service.
 * - organization_plugins / inventory_gaps: corte por plugin (módulo de pago).
 * - outbox_messages / processed_events: patrón Outbox. processed_events usa el
 *   esquema que espera InboxConsumer de @facturero/outbox-relay (0.2.0), con
 *   status/last_error — no el antiguo de `event_id + processed_at`.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. warehouses
    await queryInterface.createTable('warehouses', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      establishment_id: { type: Sequelize.CHAR(36), allowNull: true },
      code: { type: Sequelize.STRING(20), allowNull: false },
      name: { type: Sequelize.STRING(255), allowNull: false },
      address: { type: Sequelize.STRING(255), allowNull: true },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: Sequelize.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('warehouses', ['organization_id', 'code'], { unique: true });
    await queryInterface.addIndex('warehouses', ['organization_id', 'establishment_id'], { unique: true });
    // Una sola bodega default por organización (columna generada + único).
    await queryInterface.sequelize.query(
      `ALTER TABLE warehouses
         ADD COLUMN default_org_id CHAR(36)
         GENERATED ALWAYS AS (IF(is_default, organization_id, NULL)) STORED,
       ADD UNIQUE INDEX warehouses_default_org_uq (default_org_id)`,
    );

    // 2. stock_positions
    await queryInterface.createTable('stock_positions', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      product_id: { type: Sequelize.CHAR(36), allowNull: false },
      warehouse_id: { type: Sequelize.CHAR(36), allowNull: false },
      quantity_on_hand: { type: Sequelize.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
      quantity_reserved: { type: Sequelize.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
      quantity_available: { type: Sequelize.DECIMAL(18, 4), allowNull: false, defaultValue: 0 },
      average_cost_cents: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false, defaultValue: 'USD' },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('stock_positions', ['product_id', 'warehouse_id'], { unique: true });
    await queryInterface.addIndex('stock_positions', ['organization_id', 'product_id']);

    // 3. stock_movements (el kardex)
    await queryInterface.createTable('stock_movements', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      product_id: { type: Sequelize.CHAR(36), allowNull: false },
      warehouse_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: {
        type: Sequelize.ENUM(
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
      quantity: { type: Sequelize.DECIMAL(18, 4), allowNull: false },
      unit_cost_cents: { type: Sequelize.BIGINT, allowNull: true },
      total_cost_cents: { type: Sequelize.BIGINT, allowNull: true },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false, defaultValue: 'USD' },
      reference_type: { type: Sequelize.STRING(30), allowNull: true },
      reference_id: { type: Sequelize.CHAR(36), allowNull: true },
      accounting_nature: {
        type: Sequelize.ENUM('inventory_in', 'inventory_gain', 'cogs', 'expense', 'shrinkage', 'internal_transfer'),
        allowNull: false,
      },
      reason_code: { type: Sequelize.STRING(30), allowNull: true },
      lot_id: { type: Sequelize.CHAR(36), allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.CHAR(36), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('stock_movements', ['product_id', 'warehouse_id', 'created_at']);
    await queryInterface.addIndex('stock_movements', ['reference_type', 'reference_id']);
    // Lo usará el futuro generador de asientos: naturaleza + fechas.
    await queryInterface.addIndex('stock_movements', ['organization_id', 'accounting_nature', 'created_at']);

    // 4. stock_layers (FIFO)
    await queryInterface.createTable('stock_layers', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      product_id: { type: Sequelize.CHAR(36), allowNull: false },
      warehouse_id: { type: Sequelize.CHAR(36), allowNull: false },
      entry_movement_id: {
        type: Sequelize.CHAR(36),
        allowNull: false,
        references: { model: 'stock_movements', key: 'id' },
        onDelete: 'RESTRICT',
      },
      quantity_remaining: { type: Sequelize.DECIMAL(18, 4), allowNull: false },
      unit_cost_cents: { type: Sequelize.BIGINT, allowNull: false },
      currency_code: { type: Sequelize.CHAR(3), allowNull: false },
      entered_at: { type: Sequelize.DATE, allowNull: false },
      lot_id: { type: Sequelize.CHAR(36), allowNull: true },
    });
    // Sin cláusula WHERE: MySQL no tiene índices parciales. quantity_remaining
    // entra en la clave para que el filtro `> 0` (capas activas) use el índice.
    await queryInterface.addIndex('stock_layers', ['product_id', 'warehouse_id', 'quantity_remaining', 'entered_at']);

    // 5. reservations — se crea vacía, NADIE la escribe en esta fase.
    await queryInterface.createTable('reservations', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      product_id: { type: Sequelize.CHAR(36), allowNull: false },
      warehouse_id: { type: Sequelize.CHAR(36), allowNull: false },
      quantity: { type: Sequelize.DECIMAL(18, 4), allowNull: false },
      reference_type: { type: Sequelize.STRING(30), allowNull: false },
      reference_id: { type: Sequelize.CHAR(36), allowNull: false },
      status: { type: Sequelize.ENUM('active', 'confirmed', 'released', 'expired'), allowNull: false, defaultValue: 'active' },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('reservations', ['reference_type', 'reference_id']);
    await queryInterface.addIndex('reservations', ['product_id', 'warehouse_id', 'status']);

    // 6. products (read-model local)
    await queryInterface.createTable('products', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      name: { type: Sequelize.STRING(255), allowNull: true },
      sku: { type: Sequelize.STRING(64), allowNull: true },
      type: { type: Sequelize.ENUM('good', 'service'), allowNull: true },
      track_stock: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      allow_negative_stock: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      valuation_method: { type: Sequelize.ENUM('weighted_average', 'fifo'), allowNull: false, defaultValue: 'weighted_average' },
      status: { type: Sequelize.ENUM('active', 'inactive'), allowNull: true },
      inventory_account_code: { type: Sequelize.STRING(20), allowNull: true },
      cogs_account_code: { type: Sequelize.STRING(20), allowNull: true },
      expense_account_code: { type: Sequelize.STRING(20), allowNull: true },
    });

    // 7. organization_plugins (read-model de activación del módulo de pago)
    await queryInterface.createTable('organization_plugins', {
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      plugin_code: { type: Sequelize.STRING(60), allowNull: false },
      status: { type: Sequelize.ENUM('active', 'disabled'), allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('organization_plugins', ['organization_id', 'plugin_code'], { unique: true });

    // 8. inventory_gaps (huecos de servicio apagado)
    await queryInterface.createTable('inventory_gaps', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      organization_id: { type: Sequelize.CHAR(36), allowNull: false },
      started_at: { type: Sequelize.DATE, allowNull: false },
      ended_at: { type: Sequelize.DATE, allowNull: true },
      skipped_movements: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });

    // 9. outbox_messages
    await queryInterface.createTable('outbox_messages', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);

    // 10. processed_events (esquema de @facturero/outbox-relay 0.2.0)
    await queryInterface.createTable('processed_events', {
      id: { type: Sequelize.CHAR(36), primaryKey: true },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      routing_key: { type: Sequelize.STRING(200), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('processed_events');
    await queryInterface.dropTable('outbox_messages');
    await queryInterface.dropTable('inventory_gaps');
    await queryInterface.dropTable('organization_plugins');
    await queryInterface.dropTable('products');
    await queryInterface.dropTable('reservations');
    await queryInterface.dropTable('stock_layers');
    await queryInterface.dropTable('stock_movements');
    await queryInterface.dropTable('stock_positions');
    await queryInterface.dropTable('warehouses');
  },
};