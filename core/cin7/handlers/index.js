'use strict';
/**
 * Registro de handlers. O driver só conhece este mapa — acrescentar um recurso
 * é acrescentar uma linha aqui e as linhas de chunk em ops.cin7_sync_state.
 */
const makeListDetail = require('./list-detail');

module.exports = {
  sales_detail: require('./sales-detail'),
  po_detail:    makeListDetail('po_detail'),
  adj_detail:   makeListDetail('adj_detail'),
  asm_detail:   makeListDetail('asm_detail'),
  tr_detail:    makeListDetail('tr_detail'),
};
