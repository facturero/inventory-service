'use strict';

/**
 * `outbox_messages.aggregate_type` medía 50, pero casi todos los eventos de stock lo arman como
 * `${productId}:${warehouseId}` (73 caracteres) y las transferencias como `${productId}:${origen}:${destino}` (110).
 * Con MySQL en modo estricto el INSERT del outbox falla con "Data too long for column 'aggregate_type'", y como va en la
 * MISMA transacción que el movimiento, TODA entrada, salida o ajuste de stock se revertía. En producción nunca saltó
 * porque no ha habido un solo movimiento de stock (stock_movements está vacío); la primera venta con stock o la primera
 * recepción de compra lo habría descubierto.
 *
 * Se ensancha en vez de acortar el valor: el relay no lo usa para ordenar, pero quien lea el outbox puede apoyarse en
 * que identifica el agregado (producto:bodega), y cambiarlo ahora sería un cambio de contrato sin necesidad.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE outbox_messages MODIFY aggregate_type VARCHAR(150) NOT NULL');
  },

  async down(queryInterface) {
    // Volver a 50 truncaría los valores largos (y fallaría en modo estricto): solo se revierte si no hay ninguno.
    const [rows] = await queryInterface.sequelize.query('SELECT COUNT(*) AS n FROM outbox_messages WHERE CHAR_LENGTH(aggregate_type) > 50');
    if (Number(rows[0].n) === 0) {
      await queryInterface.sequelize.query('ALTER TABLE outbox_messages MODIFY aggregate_type VARCHAR(50) NOT NULL');
    }
  },
};
