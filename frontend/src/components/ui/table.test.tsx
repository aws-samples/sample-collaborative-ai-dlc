import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

describe('Table', () => {
  function renderTable() {
    return render(
      <Table>
        <TableCaption>Recent intents</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Runs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Checkout flow</TableCell>
            <TableCell>12</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
  }

  it('is named by its caption and scopes column headers to columns', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Recent intents' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(2);
    for (const header of headers) expect(header).toHaveAttribute('scope', 'col');
  });

  it('wraps the table in an overflow container so wide tables scroll instead of breaking layout', () => {
    renderTable();
    expect(screen.getByRole('table').parentElement).toHaveClass('overflow-auto');
  });
});
