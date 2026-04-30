import { useRef, useEffect, useState, useCallback } from 'react';
import type { AwarenessUser } from '../hooks/useYjsDocument';

interface Props {
  value: string;
  onChange: (value: string, cursorPos: number) => void;
  onCursorChange: (index: number, length: number) => void;
  remoteUsers: Map<number, AwarenessUser>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  rows?: number;
  /** Called when the textarea gains focus (for presence activity tracking) */
  onFocus?: () => void;
  /** Called when the textarea loses focus */
  onBlur?: () => void;
}

export function CollaborativeTextarea({
  value,
  onChange,
  onCursorChange,
  remoteUsers,
  disabled,
  placeholder,
  className,
  rows,
  onFocus,
  onBlur,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [cursorPositions, setCursorPositions] = useState<
    { user: AwarenessUser; top: number; left: number }[]
  >([]);

  // Read the textarea's actual padding so the overlay matches exactly
  const getPadding = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return { top: 8, left: 12, right: 12 };
    const style = getComputedStyle(ta);
    return {
      top: parseFloat(style.paddingTop) || 8,
      left: parseFloat(style.paddingLeft) || 12,
      right: parseFloat(style.paddingRight) || 12,
    };
  }, []);

  // Recalculate cursor positions when remoteUsers or value changes
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const positions: { user: AwarenessUser; top: number; left: number }[] = [];

    remoteUsers.forEach((user) => {
      if (user.cursor && user.cursor.index >= 0) {
        const pos = getCaretCoordinates(textarea, user.cursor.index);
        positions.push({ user, top: pos.top, left: pos.left });
      }
    });

    setCursorPositions(positions);
  }, [remoteUsers, value]);

  // Keep overlay scroll position in sync with textarea
  const handleScroll = useCallback(() => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop;
      overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const handleSelectionChange = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      onCursorChange(
        textarea.selectionStart,
        textarea.selectionEnd - textarea.selectionStart,
      );
    }
  }, [onCursorChange]);

  const handleBlur = useCallback(() => {
    onCursorChange(-1, 0);
    onBlur?.();
  }, [onCursorChange, onBlur]);

  const handleFocus = useCallback(() => {
    onFocus?.();
    // Also broadcast current cursor position on focus
    handleSelectionChange();
  }, [onFocus, handleSelectionChange]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value, e.target.selectionStart);
    },
    [onChange],
  );

  const padding = getPadding();

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onSelect={handleSelectionChange}
        onKeyUp={handleSelectionChange}
        onClick={handleSelectionChange}
        onScroll={handleScroll}
        onBlur={handleBlur}
        onFocus={handleFocus}
        placeholder={placeholder}
        className={`w-full ${className || ''}`}
        disabled={disabled}
        rows={rows}
      />
      {/* Cursor overlay — mirrors textarea geometry and scroll position */}
      <div
        ref={overlayRef}
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{
          paddingTop: padding.top,
          paddingLeft: padding.left,
          paddingRight: padding.right,
        }}
      >
        {cursorPositions.map((pos, i) => (
          <div
            key={i}
            className="absolute flex flex-col items-start"
            style={{ top: pos.top, left: pos.left }}
          >
            <div
              className="w-0.5 h-5 animate-pulse"
              style={{ backgroundColor: pos.user.color }}
            />
            <div
              className="text-[10px] text-white px-1 rounded -mt-0.5 whitespace-nowrap"
              style={{ backgroundColor: pos.user.color }}
            >
              {pos.user.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Calculate pixel position of caret in textarea by creating a hidden mirror div.
 * Subtracts textarea scrollTop so overlaid cursors scroll with the content.
 */
function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number } {
  const div = document.createElement('div');
  const style = getComputedStyle(textarea);

  // Copy relevant styles for accurate measurement
  const stylesToCopy = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'letterSpacing',
    'lineHeight',
    'textTransform',
    'wordSpacing',
    'textIndent',
    'padding',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'border',
    'borderWidth',
    'boxSizing',
    'width',
  ] as const;

  stylesToCopy.forEach((prop) => {
    div.style[prop as any] = style[prop as keyof CSSStyleDeclaration] as string;
  });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.overflow = 'hidden';

  const text = textarea.value.substring(0, position);
  div.textContent = text;

  const span = document.createElement('span');
  span.textContent = textarea.value.substring(position) || '.';
  div.appendChild(span);

  document.body.appendChild(div);

  const top = span.offsetTop - textarea.scrollTop;
  const left = span.offsetLeft;

  document.body.removeChild(div);

  return { top, left };
}
