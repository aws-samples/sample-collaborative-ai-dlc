import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConversationLanguageField } from './ConversationLanguageField';

afterEach(cleanup);

const input = () => screen.getByLabelText('Output language') as HTMLInputElement;

describe('ConversationLanguageField', () => {
  it('commits a validated tag on blur, canonicalized', () => {
    const onChange = vi.fn();
    render(<ConversationLanguageField value={null} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'pt-br' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith('pt-BR');
    expect(input().value).toBe('pt-BR');
  });

  it('shows the display-name preview while typing a valid tag', () => {
    render(<ConversationLanguageField value={null} onChange={vi.fn()} />);
    fireEvent.change(input(), { target: { value: 'ko' } });
    expect(screen.getByText(/Korean \(한국어\)/)).toBeTruthy();
  });

  it('does not commit an invalid tag and names the problem', () => {
    const onChange = vi.fn();
    render(<ConversationLanguageField value={null} onChange={onChange} />);
    fireEvent.change(input(), { target: { value: 'xx' } });
    fireEvent.blur(input());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/does not name a known language/)).toBeTruthy();
  });

  it('commits null when the field is emptied', () => {
    const onChange = vi.fn();
    render(<ConversationLanguageField value="ko" onChange={onChange} />);
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.blur(input());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('follows a peer edit while not focused', () => {
    const { rerender } = render(<ConversationLanguageField value="ko" onChange={vi.fn()} />);
    expect(input().value).toBe('ko');
    rerender(<ConversationLanguageField value="ja" onChange={vi.fn()} />);
    expect(input().value).toBe('ja');
  });
});
