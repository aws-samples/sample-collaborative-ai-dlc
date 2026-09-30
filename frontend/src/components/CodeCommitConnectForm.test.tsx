import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { connectInfo, listRepos } = vi.hoisted(() => ({ connectInfo: vi.fn(), listRepos: vi.fn() }));
vi.mock('@/services/codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/codecommit')>();
  return { ...actual, codecommitService: { connectInfo, listRepos } };
});

import { CodeCommitConnectForm } from './CodeCommitConnectForm';

const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
const ROLE = 'arn:aws:iam::123456789012:role/aidlc-access';

describe('CodeCommitConnectForm', () => {
  beforeEach(() => {
    connectInfo.mockReset().mockResolvedValue({
      externalId: EXTERNAL_ID,
      principals: ['arn:aws:iam::999999999999:role/broker'],
      trustPolicy: {
        Statement: [{ Condition: { StringEquals: { 'sts:ExternalId': EXTERNAL_ID } } }],
      },
      permissionsPolicy: {
        Statement: [
          { Action: 'codecommit:ListRepositories', Resource: '*' },
          {
            Action: ['codecommit:GitPull'],
            Resource: 'arn:aws:codecommit:<region>:<account-id>:<repository-name>',
          },
        ],
      },
      regions: ['eu-west-1', 'ap-south-2'],
    });
    listRepos.mockReset().mockResolvedValue({
      accountId: '123456789012',
      region: 'eu-west-1',
      repositories: [],
    });
  });

  it('renders the trust and permissions policies the backend returns', async () => {
    render(<CodeCommitConnectForm onVerified={() => {}} />);
    expect(await screen.findByTestId('codecommit-trust-policy')).toHaveTextContent(EXTERNAL_ID);
    const permissions = screen.getByTestId('codecommit-permissions-policy');
    expect(permissions).toHaveTextContent('codecommit:ListRepositories');
    expect(permissions).not.toHaveTextContent('codecommit:*');
    expect(connectInfo).toHaveBeenCalledWith();
  });

  it('tests the connection without sending the external id', async () => {
    const onVerified = vi.fn();
    render(<CodeCommitConnectForm initial={{ region: 'eu-west-1' }} onVerified={onVerified} />);
    await screen.findByTestId('codecommit-trust-policy');
    await userEvent.type(screen.getByLabelText('2. Role ARN'), ROLE);
    await userEvent.click(screen.getByRole('button', { name: '3. Test connection' }));
    await waitFor(() => expect(listRepos).toHaveBeenCalledTimes(1));
    expect(listRepos).toHaveBeenCalledWith({ roleArn: ROLE, region: 'eu-west-1' });
    expect(onVerified).toHaveBeenCalled();
  });
});
