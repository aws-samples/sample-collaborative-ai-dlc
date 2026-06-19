import { describe, it, expect } from 'vitest';
import type { DiscussionMessage } from '../services/discussions';
import {
  sortMessages,
  newerOf,
  changeCursorOf,
  displayCursorOf,
  makeMessageId,
  groupMessages,
  firstUnreadIndex,
  mentionedUserIds,
} from './discussion';

// NOTE: per the platform's known CI gap, frontend vitest tests do not run in
// CI yet (no frontend vitest project) — they are runnable locally via
// `npx vitest run src/lib/discussion.test.ts` from frontend/.

const msg = (over: Partial<DiscussionMessage>): DiscussionMessage => ({
  id: 'dm-1-aaaaaaaa',
  content: 'hello',
  authorId: 'user-1',
  authorName: 'Alice',
  authorType: 'user',
  mentions: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  discussionId: 'disc-1',
  sprintId: 'sprint-1',
  ...over,
});

describe('sortMessages', () => {
  it('sorts by (createdAt, id) with id tie-breaks', () => {
    const sorted = sortMessages([
      msg({ id: 'dm-2-bbbbbbbb', createdAt: '2026-01-02T00:00:00.000Z' }),
      msg({ id: 'dm-2-aaaaaaaa', createdAt: '2026-01-02T00:00:00.000Z' }),
      msg({ id: 'dm-1-aaaaaaaa', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['dm-1-aaaaaaaa', 'dm-2-aaaaaaaa', 'dm-2-bbbbbbbb']);
  });
});

describe('newerOf — merge precedence on (updatedAt, id)', () => {
  it('keeps the entry with the newer updatedAt (redaction wins over stale copy)', () => {
    const original = msg({ content: 'secret' });
    const redacted = msg({
      content: '[redacted by Admin]',
      redacted: true,
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    expect(newerOf(original, redacted)).toBe(redacted);
    expect(newerOf(redacted, original)).toBe(redacted);
  });

  it('returns the incoming message when nothing exists', () => {
    const m = msg({});
    expect(newerOf(undefined, m)).toBe(m);
  });

  it('keeps the existing entry on identical keys (idempotent upsert)', () => {
    const a = msg({});
    const b = msg({});
    expect(newerOf(a, b)).toBe(a);
  });
});

describe('cursors', () => {
  it('changeCursorOf returns the max (updatedAt, id) in wire format', () => {
    const cursor = changeCursorOf([
      msg({ id: 'dm-1-aaaaaaaa', updatedAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'dm-3-aaaaaaaa', updatedAt: '2026-01-03T00:00:00.000Z' }),
      msg({ id: 'dm-3-bbbbbbbb', updatedAt: '2026-01-03T00:00:00.000Z' }),
      msg({ id: 'dm-2-aaaaaaaa', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    expect(cursor).toBe('2026-01-03T00:00:00.000Z,dm-3-bbbbbbbb');
  });

  it('changeCursorOf returns null for an empty set', () => {
    expect(changeCursorOf([])).toBeNull();
  });

  it('displayCursorOf uses (createdAt, id)', () => {
    expect(displayCursorOf(msg({}))).toBe('2026-01-01T00:00:00.000Z,dm-1-aaaaaaaa');
  });
});

describe('makeMessageId', () => {
  it('produces server-acceptable ids (/^dm-[a-z0-9-]{8,64}$/)', () => {
    for (let i = 0; i < 50; i++) {
      expect(makeMessageId()).toMatch(/^dm-[a-z0-9-]{8,64}$/);
    }
  });
});

describe('groupMessages', () => {
  it('groups consecutive same-author messages within the window', () => {
    const groups = groupMessages([
      msg({ id: 'dm-1-a', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'dm-1-b', createdAt: '2026-01-01T00:01:00.000Z' }),
      msg({
        id: 'dm-1-c',
        authorId: 'user-2',
        authorName: 'Bob',
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      msg({ id: 'dm-1-d', createdAt: '2026-01-01T00:03:00.000Z' }),
    ]);
    expect(groups.map((g) => [g.authorId, g.messages.length])).toEqual([
      ['user-1', 2],
      ['user-2', 1],
      ['user-1', 1],
    ]);
  });

  it('starts a new group after the time window even for the same author', () => {
    const groups = groupMessages([
      msg({ id: 'dm-1-a', createdAt: '2026-01-01T00:00:00.000Z' }),
      msg({ id: 'dm-1-b', createdAt: '2026-01-01T00:10:00.000Z' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('separates agent messages from same-id user messages', () => {
    const groups = groupMessages([
      msg({ id: 'dm-1-a' }),
      msg({ id: 'dm-1-b', authorType: 'agent' }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('firstUnreadIndex', () => {
  it('places the divider before the unreadCount-last message', () => {
    expect(firstUnreadIndex(10, 3)).toBe(7);
    expect(firstUnreadIndex(3, 3)).toBe(0);
  });

  it('returns null when nothing is unread or the thread is empty', () => {
    expect(firstUnreadIndex(10, 0)).toBeNull();
    expect(firstUnreadIndex(0, 5)).toBeNull();
  });

  it('clamps when unreadCount exceeds the loaded page (capped server counts)', () => {
    expect(firstUnreadIndex(5, 99)).toBe(0);
  });
});

describe('mentionedUserIds', () => {
  const mentioned: Array<[string, string]> = [
    ['user-john', 'john'],
    ['user-johnny', 'johnny'],
  ];

  it('does NOT count a prefix label when only the longer one is mentioned', () => {
    // The bug: text.includes('@john') is true for '@johnny'.
    expect(mentionedUserIds('hey @johnny', mentioned)).toEqual(['user-johnny']);
  });

  it('counts the prefix label when it is actually mentioned', () => {
    expect(mentionedUserIds('hey @john', mentioned)).toEqual(['user-john']);
  });

  it('counts both when both are mentioned', () => {
    expect(mentionedUserIds('@john and @johnny', mentioned)).toEqual(['user-john', 'user-johnny']);
  });

  it('matches a mention at the very start of the text', () => {
    expect(mentionedUserIds('@john hi', [['user-john', 'john']])).toEqual(['user-john']);
  });

  it('requires an @ — a bare label does not count', () => {
    expect(mentionedUserIds('john was here', [['user-john', 'john']])).toEqual([]);
  });

  it('does not match a label glued to a preceding mention char (email-ish)', () => {
    // `foo@john` is an email-like token, not a mention.
    expect(mentionedUserIds('foo@john', [['user-john', 'john']])).toEqual([]);
  });

  it('handles labels containing regex-special and mention charset chars', () => {
    expect(mentionedUserIds('ping @john.doe please', [['user-jd', 'john.doe']])).toEqual([
      'user-jd',
    ]);
    // `john.doe` must not be falsely matched by a `john.do` prefix label.
    expect(
      mentionedUserIds('ping @john.doe', [
        ['user-prefix', 'john.do'],
        ['user-jd', 'john.doe'],
      ]),
    ).toEqual(['user-jd']);
  });

  it('returns an empty array when nothing is mentioned', () => {
    expect(mentionedUserIds('no mentions here', mentioned)).toEqual([]);
  });
});
