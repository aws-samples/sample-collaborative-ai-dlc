import * as React from 'react';
import { Link } from 'react-router';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  numeric?: boolean;
  /** CSS width applied through `<colgroup>`; any width switches the table to `table-fixed`. */
  width?: string;
  /** Hide the column while the table's container is narrower than 34rem (`sm`) / 48rem (`md`). */
  hideBelow?: 'sm' | 'md';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  /** Makes the whole row navigate; the first cell becomes the (only) focusable link. */
  rowHref?: (row: T) => string;
  /** Accessible name for the row link when the first cell text is not descriptive. */
  rowLabel?: (row: T) => string;
  /** Rendered in a trailing cell above the row link, so clicking them never navigates. */
  rowActions?: (row: T) => React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
  empty?: React.ReactNode;
  caption?: string;
  'aria-label'?: string;
  className?: string;
}

const hideBelowClass: Record<NonNullable<DataTableColumn<unknown>['hideBelow']>, string> = {
  sm: 'hidden @[34rem]:table-cell',
  md: 'hidden @[48rem]:table-cell',
};

const hideBelowColClass: Record<NonNullable<DataTableColumn<unknown>['hideBelow']>, string> = {
  sm: 'hidden @[34rem]:table-column',
  md: 'hidden @[48rem]:table-column',
};

const INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,summary,[role="button"],[role="menuitem"],[role="link"]';

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  rowHref,
  rowLabel,
  rowActions,
  rowClassName,
  empty,
  caption,
  className,
  ...props
}: DataTableProps<T>) {
  const fixed = columns.some((column) => column.width);
  const columnCount = columns.length + (rowActions ? 1 : 0);
  const [first, ...rest] = columns;

  const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest(INTERACTIVE_SELECTOR)) return;
    event.currentTarget.querySelector<HTMLAnchorElement>('a[data-row-link]')?.click();
  };

  return (
    <div
      className={cn(
        '@container overflow-hidden rounded-lg border bg-card text-card-foreground',
        className,
      )}
    >
      <Table
        aria-label={props['aria-label']}
        className={cn('border-collapse text-sm', fixed && 'table-fixed')}
      >
        {caption ? <TableCaption className="sr-only">{caption}</TableCaption> : null}
        <colgroup>
          {columns.map((column) => (
            <col
              key={column.id}
              style={column.width ? { width: column.width } : undefined}
              className={column.hideBelow ? hideBelowColClass[column.hideBelow] : undefined}
            />
          ))}
          {rowActions ? <col className="w-12" /> : null}
        </colgroup>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => (
              <TableHead
                key={column.id}
                numeric={column.numeric}
                className={cn('px-3', column.hideBelow && hideBelowClass[column.hideBelow])}
              >
                {column.header}
              </TableHead>
            ))}
            {rowActions ? (
              <TableHead className="px-1">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && empty ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const href = rowHref?.(row);
              const firstContent = first.cell(row);
              return (
                <TableRow
                  key={getRowId(row)}
                  onClick={href ? handleRowClick : undefined}
                  className={cn(
                    'group relative',
                    href && 'hover:bg-accent/50 focus-within:bg-accent/50',
                    rowClassName?.(row),
                  )}
                >
                  <th
                    scope="row"
                    className={cn(
                      'p-2 px-3 text-left align-middle font-medium',
                      first.numeric && 'text-right tabular-nums',
                      first.hideBelow && hideBelowClass[first.hideBelow],
                    )}
                  >
                    {href ? (
                      <Link
                        to={href}
                        data-row-link=""
                        aria-label={rowLabel?.(row)}
                        className="break-words after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                      >
                        {firstContent}
                      </Link>
                    ) : (
                      firstContent
                    )}
                  </th>
                  {rest.map((column) => (
                    <TableCell
                      key={column.id}
                      numeric={column.numeric}
                      className={cn('px-3', column.hideBelow && hideBelowClass[column.hideBelow])}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                  {rowActions ? (
                    <TableCell className="relative z-10 px-1 text-center">
                      {rowActions(row)}
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
