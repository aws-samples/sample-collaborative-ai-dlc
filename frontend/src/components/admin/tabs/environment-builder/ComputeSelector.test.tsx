import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComputeCapability, ComputeSelection } from '@/services/environments';
import { ComputeBadge, ComputeSelector } from './ComputeSelector';
import { computeTypeAvailability, selectComputeType } from './model';

const FULL: ComputeCapability[] = [
  { type: 'microvms', architecture: 'arm64', available: true },
  {
    type: 'microvms',
    architecture: 'x86_64',
    available: false,
    reason: 'MICROVMS_ARCHITECTURE_UNSUPPORTED',
  },
  {
    type: 'instances',
    architecture: 'arm64',
    available: true,
    allowedInstanceTypes: ['m7g.large'],
  },
  {
    type: 'instances',
    architecture: 'x86_64',
    available: true,
    allowedInstanceTypes: ['m6i.large'],
  },
];

const INSTANCES_OFF: ComputeCapability[] = [
  { type: 'microvms', architecture: 'arm64', available: true },
  {
    type: 'microvms',
    architecture: 'x86_64',
    available: false,
    reason: 'MICROVMS_ARCHITECTURE_UNSUPPORTED',
  },
  {
    type: 'instances',
    architecture: 'arm64',
    available: false,
    reason: 'INSTANCES_COMPUTE_NOT_CONFIGURED',
  },
  {
    type: 'instances',
    architecture: 'x86_64',
    available: false,
    reason: 'INSTANCES_COMPUTE_NOT_CONFIGURED',
  },
];

const renderSelector = (value: ComputeSelection, cells = FULL) => {
  const onChange = vi.fn();
  render(<ComputeSelector value={value} cells={cells} onChange={onChange} />);
  return { onChange };
};

const toggle = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}$`, 'i') });

describe('ComputeSelector', () => {
  it('renders compute type and architecture as two separate controls', () => {
    renderSelector({ type: 'microvms', architecture: 'arm64' });
    expect(screen.getByRole('group', { name: 'Compute type' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Architecture' })).toBeInTheDocument();
    expect(toggle('microVMs')).toHaveAttribute('data-state', 'on');
    expect(toggle('arm64')).toHaveAttribute('data-state', 'on');
  });

  it('disables x86_64 on microVMs and says why', () => {
    renderSelector({ type: 'microvms', architecture: 'arm64' });
    expect(toggle('x86_64')).toBeDisabled();
    expect(screen.getByText(/not offered on microVMs yet/)).toBeInTheDocument();
  });

  it('keeps the architecture when switching compute type if the pair is available', async () => {
    const { onChange } = renderSelector({ type: 'microvms', architecture: 'arm64' });
    await userEvent.click(toggle('Instances'));
    expect(onChange).toHaveBeenCalledWith({ type: 'instances', architecture: 'arm64' });
  });

  it('changes only the architecture on Instances and lists the allowed instance types', async () => {
    const { onChange } = renderSelector({ type: 'instances', architecture: 'arm64' });
    expect(screen.getByText('m7g.large')).toBeInTheDocument();
    await userEvent.click(toggle('x86_64'));
    expect(onChange).toHaveBeenCalledWith({ type: 'instances', architecture: 'x86_64' });
  });

  it('disables Instances with the deployment reason when it is not enabled', () => {
    renderSelector({ type: 'microvms', architecture: 'arm64' }, INSTANCES_OFF);
    expect(toggle('Instances')).toBeDisabled();
    expect(toggle('Instances')).toHaveAttribute(
      'title',
      'Instances is not enabled on this deployment',
    );
  });
});

describe('ComputeBadge', () => {
  it('shows the compute type and the architecture as separate segments', () => {
    render(<ComputeBadge compute={{ type: 'instances', architecture: 'x86_64' }} />);
    expect(screen.getByText('Instances')).toBeInTheDocument();
    expect(screen.getByText('x86_64')).toBeInTheDocument();
  });

  it('defaults to microVMs · arm64 for records without a compute field', () => {
    render(<ComputeBadge compute={null} />);
    expect(screen.getByText('microVMs')).toBeInTheDocument();
    expect(screen.getByText('arm64')).toBeInTheDocument();
  });
});

describe('two-axis model helpers', () => {
  it('falls back to an available architecture when the pair is not supported', () => {
    expect(
      selectComputeType(FULL, { type: 'instances', architecture: 'x86_64' }, 'microvms'),
    ).toEqual({ type: 'microvms', architecture: 'arm64' });
  });

  it('reports a compute type as available when any architecture is', () => {
    expect(computeTypeAvailability(FULL, 'instances')).toEqual({ available: true, reason: null });
    expect(computeTypeAvailability(INSTANCES_OFF, 'instances')).toEqual({
      available: false,
      reason: 'Instances is not enabled on this deployment',
    });
  });
});
