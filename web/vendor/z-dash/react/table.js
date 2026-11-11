/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * <Table> (dist/react/table.js): the .ds-table of docs/components.md,
 * "Table", from columns and rows, in its .ds-table-wrap.
 *
 *   createElement(Table, {
 *     caption: 'Devices',
 *     columns: [
 *       { key: 'name', header: 'Device', sortable: true, text: true },
 *       { key: 'age', header: 'Age', numeric: true, sortable: true },
 *       { key: 'owner', header: 'Owner', secondary: true },
 *       { key: 'status', header: 'Status', render: (row) => createElement(Status, { tone: row.tone }, row.state) },
 *     ],
 *     rows, rowKey: (row) => row.id,
 *     sort: { key: 'age', direction: 'descending' },
 *     onSort: (key, direction) => setSort({ key, direction }),
 *   })
 *
 * Props: columns ({ key, header, numeric (.ds-num), secondary
 * (.ds-col--secondary, dropped on phones), text (.ds-col--text), nowrap,
 * sortable, render(row, index) }), rows, rowKey (default row.id, else the
 * index; written as data-ds-key), caption (the table's name; visually
 * hidden unless captionVisible), sort ({ key, direction: 'ascending' |
 * 'descending' }: aria-sort and the arrow on that column), onSort(key,
 * direction) (a press on a sortable header: the other direction, or
 * ascending for a new column), variant ('zebra', 'bordered', 'plain',
 * 'wide', or a list), wrapLabel (the wrapper becomes a focusable region of
 * that name, for a table whose cells hold nothing focusable), density,
 * size, and every prop of the <table>. Without columns the children go
 * into the <table> as they are (your own thead and tbody). Sorting and
 * filtering are the page's: render the rows in their new order.
 *
 * ES2022, no JSX. Progressive: none.
 */
import { createElement, forwardRef } from 'react';
import { arrowUp } from '../js/icons.js';
import { cx, iconNode, modifiers, optionClasses, splitOptions } from './shared.js';

const keyOf = (row, index, rowKey) => (typeof rowKey === 'function' ? rowKey(row, index) : row?.id ?? index);

export const Table = forwardRef(function Table(props, ref) {
  const [options, rest] = splitOptions(props);
  const { columns, rows = [], rowKey, caption, captionVisible, sort, onSort, variant, wrapLabel, className, children, ...attributes } = rest;
  const cellClass = (column) => cx(column.numeric && 'ds-num', column.secondary && 'ds-col--secondary', column.text && 'ds-col--text', column.nowrap && 'ds-nowrap') || undefined;
  let body = [children];
  if (columns) {
    const head = createElement('thead', null, createElement('tr', null, columns.map((column) => {
      const sorted = sort?.key === column.key ? sort.direction ?? 'ascending' : null;
      const content = column.sortable
        ? createElement('button', {
          className: 'ds-table__sort',
          type: 'button',
          onClick: () => onSort?.(column.key, sorted === 'ascending' ? 'descending' : 'ascending'),
        // The arrow at the sorted column only, after the label: a .ds-num column puts it first in CSS (row-reverse),
        // and an unsorted one keeps its room as padding, so moving the sort never resizes the columns.
        }, column.header, sorted ? iconNode(arrowUp, 16, 'ds-table__sort-arrow') : null)
        : column.header;
      return createElement('th', { key: column.key, scope: 'col', className: cellClass(column), ...(sorted ? { 'aria-sort': sorted } : {}) }, content);
    })));
    const rowsNode = createElement('tbody', null, rows.map((row, index) => {
      const key = keyOf(row, index, rowKey);
      return createElement('tr', { key, 'data-ds-key': String(key) }, columns.map((column) => createElement('td', { key: column.key, className: cellClass(column) },
        column.render ? column.render(row, index) : row?.[column.key])));
    }));
    body = [head, rowsNode];  // arguments of their own: no keys needed
  }
  const table = createElement('table', { ...attributes, ref, className: cx('ds-table', modifiers('ds-table', variant), className) },
    caption ? createElement('caption', { className: captionVisible ? undefined : 'ds-sr' }, caption) : null,
    ...body);
  return createElement('div', {
    className: cx('ds-table-wrap', optionClasses({ ...options, tone: undefined })),
    ...(wrapLabel ? { tabIndex: 0, role: 'region', 'aria-label': wrapLabel } : {}),
  }, table);
});
Table.displayName = 'Table';
